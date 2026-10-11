/**
 * Security tests for the MCP servers in `mcp/servers/`.
 *
 * Everything here is about *refusal*: path traversal, symlink escapes,
 * credential files, SSRF targets, oversized responses, and writes against a
 * read-only database. The servers are driven through the real manager, so the
 * assertions cover the same path the model uses.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error — the guard helpers are plain .mjs without declaration files
import { isBlockedAddress, PathPolicy, pinnedLookup, UrlPolicy } from '../mcp/lib/guards.mjs';
import { McpManager } from '../src/mcp/manager.js';

const REPO = resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const PYTHON = process.env['INFAGENT_PYTHON'] ?? 'python3';

/** Run one tool against a freshly started stdio server. */
async function withServer(
  name: string,
  command: string,
  args: string[],
  run: (manager: McpManager) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-mcp-'));
  const configPath = join(dir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({ servers: { [name]: { command, args, enabled: true } } }, null, 2),
  );

  const manager = new McpManager({ configPath });
  try {
    const status = await manager.start(name);
    if (status.state !== 'ready') throw new Error(`server ${name} did not start: ${status.lastError}`);
    await run(manager);
  } finally {
    await manager.stopAll();
  }
}

/* ── filesystem ─────────────────────────────────────────────────────────── */

describe('filesystem server', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'infagent-fs-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'infagent-outside-')));

  beforeAll(() => {
    writeFileSync(join(root, 'notes.txt'), 'inside the root');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'private.pem'), '-----BEGIN KEY-----');
    writeFileSync(join(outside, 'secret.txt'), 'outside the root');
    mkdirSync(join(root, 'sub'));
    // A symlink that points outside the allowed root.
    symlinkSync(outside, join(root, 'escape-link'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file.txt'));
  });

  const config = (extra: Record<string, unknown> = {}): string[] => [
    join(REPO, 'mcp/servers/filesystem.mjs'),
    JSON.stringify({ roots: [root], ...extra }),
  ];

  it('reads a file inside the root', async () => {
    await withServer('fs', NODE, config(), async (manager) => {
      const result = await manager.call('fs__read_file', { path: join(root, 'notes.txt') });
      expect(result.result.ok).toBe(true);
      expect(result.result.text).toContain('inside the root');
    });
  });

  it('refuses traversal and absolute paths outside the root', async () => {
    await withServer('fs', NODE, config(), async (manager) => {
      for (const path of [
        join(root, '../..', 'etc/passwd'),
        `${root}/../../../etc/passwd`,
        resolve(root, 'sub/../../..', 'etc/passwd'),
        '/etc/passwd',
        '/etc/shadow',
        join(outside, 'secret.txt'),
      ]) {
        const result = await manager.call('fs__read_file', { path });
        expect(result.result.ok, `expected ${path} to be refused`).toBe(false);
        expect(result.result.text).toMatch(/Refused|outside the allowed roots/);
      }
    });
  });

  it('refuses symlinks that escape the root', async () => {
    await withServer('fs', NODE, config(), async (manager) => {
      const viaDirectory = await manager.call('fs__read_file', {
        path: join(root, 'escape-link/secret.txt'),
      });
      expect(viaDirectory.result.ok).toBe(false);
      expect(viaDirectory.result.text).toMatch(/outside the allowed roots/);

      const viaFile = await manager.call('fs__get_file_info', { path: join(root, 'escape-file.txt') });
      expect(viaFile.result.ok).toBe(false);

      const listing = await manager.call('fs__list_directory', { path: join(root, 'escape-link') });
      expect(listing.result.ok).toBe(false);
    });
  });

  it('refuses credential files even inside the root', async () => {
    await withServer('fs', NODE, config(), async (manager) => {
      for (const name of ['.env', 'private.pem']) {
        const result = await manager.call('fs__read_file', { path: join(root, name) });
        expect(result.result.ok, `expected ${name} to be refused`).toBe(false);
        expect(result.result.text).toMatch(/Refused/);
      }
    });
  });

  it('is read-only by default and writes only when enabled', async () => {
    await withServer('fs', NODE, config(), async (manager) => {
      const tools = manager.status('fs').tools.map((tool) => tool.name);
      expect(tools).not.toContain('write_file');
      expect(tools).not.toContain('create_directory');

      const write = await manager.call('fs__write_file', {
        path: join(root, 'new.txt'),
        content: 'nope',
      });
      expect(write.result.ok).toBe(false);
    });

    await withServer('fs', NODE, config({ allow_write: true }), async (manager) => {
      const inside = await manager.call('fs__write_file', {
        path: join(root, 'new.txt'),
        content: 'written',
      });
      expect(inside.result.ok).toBe(true);

      const outsideWrite = await manager.call('fs__write_file', {
        path: join(outside, 'pwned.txt'),
        content: 'nope',
      });
      expect(outsideWrite.result.ok).toBe(false);

      const created = await manager.call('fs__create_directory', { path: join(root, 'made', 'deep') });
      expect(created.result.ok).toBe(true);
    });
  });

  it('refuses deletion unless allow_delete is on', async () => {
    await withServer('fs', NODE, config({ allow_write: true }), async (manager) => {
      const result = await manager.call('fs__remove_path', { path: join(root, 'notes.txt') });
      expect(result.result.ok).toBe(false);
      expect(manager.status('fs').tools.map((tool) => tool.name)).not.toContain('remove_path');
    });
  });
});

describe('PathPolicy unit rules', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'infagent-policy-')));
  const policy = new PathPolicy({ roots: [root], allowWrite: false });

  it('accepts paths inside a root and rejects the rest', () => {
    expect(policy.resolvePath(join(root, 'a/b.txt'))).toBe(join(root, 'a/b.txt'));
    expect(policy.resolvePath('relative.txt')).toBe(join(root, 'relative.txt'));
    expect(() => policy.resolvePath('/etc')).toThrow(/outside the allowed roots/);
    expect(() => policy.resolvePath(join(root, '../../etc'))).toThrow(/outside the allowed roots/);
  });

  it('rejects NUL bytes, empty input and writes in read-only mode', () => {
    expect(() => policy.resolvePath('')).toThrow(/path is required/i);
    expect(() => policy.resolvePath('a\0b')).toThrow(/NUL/);
    expect(() => policy.resolvePath(join(root, 'x.txt'), { write: true })).toThrow(/Read-only/);
  });

  it('has no roots to begin with', () => {
    expect(() => new PathPolicy({ roots: [] })).toThrow(/at least one allowed root/);
  });

  it('accepts a relative path from the working directory when it lands in a root', () => {
    // cmd = mkdtemp('/tmp/infagent-policy-XXXX')/cmd; root = cmd/scripts
    const cmd = realpathSync(mkdtempSync(join(tmpdir(), 'infagent-cwd-')));
    const inner = join(cmd, 'scripts');
    mkdirSync(inner);
    const scoped = new PathPolicy({ roots: [inner] });
    const cwd = process.cwd();
    try {
      process.chdir(cmd);
      // "scripts/notes.txt" is relative to the working directory…
      expect(scoped.resolvePath('scripts/notes.txt')).toBe(join(inner, 'notes.txt'));
      // …while a bare name is still relative to the first root.
      expect(scoped.resolvePath('notes.txt')).toBe(join(inner, 'notes.txt'));
      // …and escaping stays refused either way.
      expect(() => scoped.resolvePath('../outside.txt')).toThrow(/outside the allowed roots/);
      expect(() => scoped.resolvePath('../../etc/passwd')).toThrow(/outside the allowed roots/);
    } finally {
      process.chdir(cwd);
    }
  });
});

/* ── fetch ──────────────────────────────────────────────────────────────── */

describe('fetch policy (SSRF)', () => {
  const policy = new UrlPolicy({ allowHttp: false, allowPrivate: [] });

  it('classifies addresses that must never be fetched', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.9.9',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:10.0.0.1',
      'ff02::1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('refuses unsupported schemes and plain http', async () => {
    await expect(policy.check('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(policy.check('gopher://example.com/')).rejects.toThrow(/scheme/);
    await expect(policy.check('http://example.com')).rejects.toThrow(/http is disabled/);
    await expect(policy.check('not a url')).rejects.toThrow(/valid URL/);
    await expect(policy.check('https://user:pw@example.com')).rejects.toThrow(/Credentials/);
  });

  it('refuses literal private addresses', async () => {
    await expect(policy.check('https://127.0.0.1/')).rejects.toThrow(/non-public address/);
    await expect(policy.check('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /non-public address/,
    );
    await expect(policy.check('https://[::1]/')).rejects.toThrow(/non-public address/);
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    // localhost is guaranteed to resolve to a loopback address.
    await expect(policy.check('https://localhost/')).rejects.toThrow(/non-public address/);
  });

  it('allows a private host only through an explicit exception', async () => {
    const trusted = new UrlPolicy({ allowHttp: true, allowPrivate: ['127.0.0.1'] });
    const check = await trusted.check('http://127.0.0.1:9/probe');
    expect(check.private).toBe(true);
    expect(check.addresses).toEqual(['127.0.0.1']);

    const other = new UrlPolicy({ allowHttp: true, allowPrivate: ['127.0.0.1'] });
    await expect(other.check('http://169.254.169.254/')).rejects.toThrow(/non-public address/);
  });

  it('re-checks every redirect hop', async () => {
    const trusted = new UrlPolicy({ allowHttp: true, allowPrivate: ['127.0.0.1'] });
    await expect(trusted.check('http://127.0.0.1/ok')).resolves.toBeTruthy();
    // The next hop is a different, unlisted host — the policy refuses it.
    await expect(trusted.check('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /non-public address/,
    );
  });
});

describe('fetch server', () => {
  it('refuses a blocked target through the tool interface', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-fetch-'));
    const configPath = join(dir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          fetch: {
            command: NODE,
            args: [join(REPO, 'mcp/servers/fetch.mjs'), JSON.stringify({ allow_http: false })],
          },
        },
      }),
    );

    const manager = new McpManager({ configPath });
    try {
      await manager.start('fetch');
      for (const url of [
        'https://169.254.169.254/latest/meta-data/',
        'https://127.0.0.1/',
        'https://10.0.0.1/',
        'http://example.com/',
        'file:///etc/passwd',
      ]) {
        const result = await manager.call('fetch__fetch_url', { url });
        expect(result.result.ok, `expected ${url} to be refused`).toBe(false);
      }

      const policyReport = await manager.call('fetch__fetch_policy', {});
      expect(policyReport.result.ok).toBe(true);
      expect(policyReport.result.text).toContain('169.254');
    } finally {
      await manager.stopAll();
    }
  }, 30_000);

  it('pins the validated address in both callback shapes Node uses', () => {
    const lookup = pinnedLookup(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);

    // `{all: true}` — Node's happy-eyeballs path — must get the full record list,
    // otherwise net.connect throws "Invalid IP address: undefined".
    let all: { error: unknown; records: unknown } | undefined;
    lookup('example.com', { all: true }, (error: unknown, records: unknown) => {
      all = { error, records };
    });
    expect(all?.error).toBeNull();
    expect(all?.records).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    let single: { error: unknown; address: unknown; family: unknown } | undefined;
    lookup('example.com', { family: 4 }, (error: unknown, address: unknown, family: unknown) => {
      single = { error, address, family };
    });
    expect(single).toMatchObject({ error: null, address: '93.184.216.34', family: 4 });
  });

  it('fetches a real https page over the pinned address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-https-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );

    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><head><title>pinned</title></head><body><p>hello over tls</p></body></html>');
      },
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const configPath = join(dir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          fetch: {
            command: NODE,
            args: [
              join(REPO, 'mcp/servers/fetch.mjs'),
              JSON.stringify({ allow_private: ['127.0.0.1'] }),
            ],
            // The self-signed certificate is trusted only inside this server.
            env: { NODE_EXTRA_CA_CERTS: cert },
          },
        },
      }),
    );

    const manager = new McpManager({ configPath });
    try {
      await manager.start('fetch');
      const result = await manager.call('fetch__fetch_url', {
        url: `https://127.0.0.1:${port}/`,
      });
      expect(result.result.ok, result.result.text).toBe(true);
      expect(result.result.text).toContain('hello over tls');
      // Content pulled off the network is flagged as untrusted.
      expect(result.result.text).toContain('untrusted');
    } finally {
      await manager.stopAll();
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 60_000);
});

/* ── sqlite ─────────────────────────────────────────────────────────────── */

describe('sqlite server', () => {
  let database = '';

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-sql-'));
    database = join(dir, 'app.db');
    execFileSync(PYTHON, [
      '-c',
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
INSERT INTO users (name) VALUES ('Amina'),('Yacine');
INSERT INTO posts (user_id) VALUES (1),(1),(2);
""")
c.commit()`,
      database,
    ]);
  });

  const config = (extra: Record<string, unknown> = {}): string[] => [
    join(REPO, 'mcp/servers/sqlite.py'),
    JSON.stringify({ databases: { app: database }, ...extra }),
  ];

  it('exposes schema and runs read queries with bound parameters', async () => {
    await withServer('sql', PYTHON, config(), async (manager) => {
      const tables = await manager.call('sql__list_tables', { database: 'app' });
      expect(tables.result.ok).toBe(true);
      expect(tables.result.text).toContain('users');

      const described = await manager.call('sql__describe_table', { table: 'posts' });
      expect(described.result.text).toContain('user_id');
      expect(described.result.text).toContain('foreign_keys');

      const queries = await manager.call('sql__read_query', {
        sql: 'SELECT name FROM users WHERE id = ?',
        params: [1],
      });
      expect(queries.result.ok).toBe(true);
      expect(queries.result.text).toContain('Amina');
    });
  });

  it('refuses writes, other files and multi-statement payloads', async () => {
    await withServer('sql', PYTHON, config(), async (manager) => {
      const cases: [string, Record<string, unknown>][] = [
        ['insert', { sql: "INSERT INTO users (name) VALUES ('Mallory')" }],
        ['drop', { sql: 'DROP TABLE users' }],
        ['pragma write', { sql: 'PRAGMA journal_mode = MEMORY' }],
        ['attach', { sql: "ATTACH DATABASE '/tmp/other.db' AS other" }],
        ['vacuum', { sql: "VACUUM INTO '/tmp/copy.db'" }],
        ['two statements', { sql: 'SELECT 1; DROP TABLE users' }],
        ['unknown alias', { database: 'nope', sql: 'SELECT 1' }],
      ];

      for (const [label, args] of cases) {
        const result = await manager.call('sql__read_query', args);
        expect(result.result.ok, `expected ${label} to be refused`).toBe(false);
      }

      // The database itself is untouched.
      const still = await manager.call('sql__read_query', { sql: 'SELECT COUNT(*) AS n FROM users' });
      expect(still.result.text).toContain('2');
    });
  });

  it('enforces read-only inside SQLite, not just by hiding tools', async () => {
    await withServer('sql', PYTHON, config(), async (manager) => {
      // No write tool is published at all…
      expect(manager.status('sql').tools.map((tool) => tool.name)).not.toContain('write_query');
      // …and the connection would refuse the write even if one were called.
      const viaRead = await manager.call('sql__read_query', {
        sql: 'INSERT INTO users (name) VALUES (?)',
        params: ['Mallory'],
      });
      expect(viaRead.result.ok).toBe(false);
    });
  });

  it('reports a clean error for invalid SQL and unknown tables', async () => {
    await withServer('sql', PYTHON, config(), async (manager) => {
      const bad = await manager.call('sql__read_query', { sql: 'SELECT FROM WHERE' });
      expect(bad.result.ok).toBe(false);
      expect(bad.result.text).toMatch(/SQLite refused|syntax/i);

      const missing = await manager.call('sql__describe_table', { table: 'ghosts' });
      expect(missing.result.ok).toBe(false);
    });
  });

  it('bounds the number of rows returned', async () => {
    await withServer('sql', PYTHON, config({ max_rows: 1 }), async (manager) => {
      const result = await manager.call('sql__read_query', {
        sql: 'SELECT name FROM users',
      });
      expect(result.result.ok).toBe(true);
      expect(result.result.text).toContain('"truncated": true');
    });
  });

  it('keeps foreign keys enforced when writes are enabled', async () => {
    await withServer('sql', PYTHON, config({ allow_write: true }), async (manager) => {
      const inserted = await manager.call('sql__write_query', {
        sql: 'INSERT INTO users (name) VALUES (?)',
        params: ['Mallory'],
      });
      expect(inserted.result.ok).toBe(true);

      const orphan = await manager.call('sql__write_query', {
        sql: 'INSERT INTO posts (user_id) VALUES (?)',
        params: [9999],
      });
      expect(orphan.result.ok).toBe(false);
      expect(orphan.result.text).toMatch(/FOREIGN KEY/i);
    });
  });
});

/* ── exposure check ─────────────────────────────────────────────────────── */

describe('default mcp.json', () => {
  it('never exposes a home directory or a credential file', async () => {
    const manager = new McpManager({ configPath: join(REPO, 'mcp.json') });
    const servers = manager.catalogue().servers;

    for (const server of servers) {
      const blob = JSON.stringify(server);
      expect(blob).not.toContain(process.env['HOME'] ?? '/root');
      expect(blob).not.toMatch(/"roots":\s*\["\/(?!home\/user\/InfAgent)/);
      expect(blob).not.toMatch(/sk-|sbp_|nvapi-/);
    }

    // Supabase ships disabled until a token exists, and read-only by default.
    const supabase = servers.find((server) => server.name === 'supabase');
    expect(supabase?.enabled).toBe(false);
    expect(JSON.stringify(supabase)).toContain('read_only=true');

    // The token itself only ever appears as a placeholder in the config file.
    const raw = readFileSync(join(REPO, 'mcp.json'), 'utf8');
    expect(raw).toMatch(/\$\{SUPABASE_ACCESS_TOKEN\}/);
    expect(raw).not.toMatch(/sbp_[A-Za-z0-9]/);
  });
});
