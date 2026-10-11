/**
 * Enforcement layer shared by the filesystem and fetch MCP servers.
 *
 * Everything here is a *block*, not advice: a violation throws and the tool
 * call fails. The rules never depend on the model behaving well.
 */
import { promises as dns } from 'node:dns';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export class PolicyError extends Error {
  constructor(message, code = 'denied') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

/* ── paths ───────────────────────────────────────────────────────────────── */

/**
 * Names that are refused wherever they appear in a path: credentials,
 * environment files and private keys.
 */
const SENSITIVE_NAMES = [
  '.env',
  '.env.local',
  '.env.production',
  'env.txt',
  '.netrc',
  '_netrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'service-account.json',
  '.npmrc',
  '.pypirc',
  '.htpasswd',
  'shadow',
  'passwd',
  'sudoers',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
];

const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.gpg', '.docker', '.kube', '.config/gcloud'];
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks'];

function sensitive(parts) {
  const lower = parts.map((part) => part.toLowerCase());
  for (const part of lower) {
    if (part === '.git') return '.git is not readable';
    if (SENSITIVE_DIRS.includes(part)) return `${part} holds credentials`;
    if (SENSITIVE_NAMES.includes(part)) return `${part} holds credentials`;
    if (SENSITIVE_SUFFIXES.some((suffix) => part.endsWith(suffix))) return `${part} looks like a key`;
    if (/^\.env(\.|$)/.test(part)) return `${part} holds credentials`;
  }
  const joined = lower.join('/');
  for (const dir of SENSITIVE_DIRS) {
    if (joined.includes(`${dir}/`)) return `${dir} holds credentials`;
  }
  return null;
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Path policy: a fixed list of roots, an optional write switch and a check for
 * `..` traversal, symlinks and sensitive names.
 *
 * Symlinks are resolved through the deepest existing ancestor, so a link that
 * points outside a root is refused even when the target does not exist yet.
 */
export class PathPolicy {
  constructor({ roots, allowWrite = false, allowDelete = false }) {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new PolicyError('The filesystem server needs at least one allowed root in its config.');
    }
    this.allowWrite = Boolean(allowWrite);
    this.allowDelete = Boolean(allowDelete);
    this.roots = roots.map((root) => {
      const absolute = resolve(root);
      if (!existsSync(absolute)) throw new PolicyError(`Allowed root does not exist: ${absolute}`);
      return realpathSync(absolute);
    });
  }

  /** Absolute, symlink-resolved path, or a PolicyError explaining the refusal. */
  resolvePath(input, { write = false } = {}) {
    if (typeof input !== 'string' || !input.trim()) {
      throw new PolicyError('A path is required.', 'bad_request');
    }
    if (input.includes('\0')) throw new PolicyError('The path contains a NUL byte.', 'bad_request');

    const raw = input.trim();
    const absolute = this.#absoluteFor(raw);
    const resolved = this.#deepRealpath(absolute);

    const root = this.roots.find((candidate) => inside(resolved, candidate));
    if (!root) {
      throw new PolicyError(
        `Refused: ${absolute} is outside the allowed roots (${this.roots.join(', ')}).`,
      );
    }

    const parts = relative(root, resolved).split(sep).filter(Boolean);
    const flagged = sensitive(parts);
    if (flagged) throw new PolicyError(`Refused: ${flagged}.`);

    if (write && !this.allowWrite) {
      throw new PolicyError('Read-only mode: this server was started without write access.');
    }

    return resolved;
  }

  /**
   * Turn an input path into an absolute one. Absolute paths are used as given.
   * A relative path is first tried against the process working directory (the
   * config directory, i.e. the InfAgent repo) and only then against the first
   * allowed root, so both "scripts/hello.js" and "hello.js" work. Either way the
   * result still has to land inside an allowed root or it is refused.
   */
  #absoluteFor(raw) {
    if (isAbsolute(raw)) return normalize(raw);
    const fromCwd = resolve(process.cwd(), raw);
    if (this.roots.some((root) => inside(normalize(fromCwd), root))) return fromCwd;
    return resolve(this.roots[0], raw);
  }

  /** realpath of the deepest part that exists, plus the rest appended verbatim. */
  #deepRealpath(absolute) {
    let current = absolute;
    const tail = [];
    for (;;) {
      try {
        return normalize(join(realpathSync(current), ...tail.reverse()));
      } catch {
        const parent = resolve(current, '..');
        if (parent === current) return normalize(absolute);
        tail.push(current.slice(parent.length + 1));
        current = parent;
      }
    }
  }
}

/* ── URLs ────────────────────────────────────────────────────────────────── */

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this host"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function v4ToInt(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function v6ToBits(address) {
  const [head, tail] = address.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined) return null;
  const groups = [...left, ...Array(Math.max(missing, 0)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let bits = 0n;
  for (const group of groups) {
    const value = Number.parseInt(group || '0', 16);
    if (Number.isNaN(value)) return null;
    bits = (bits << 16n) | BigInt(value);
  }
  return bits;
}

function inPrefixV6(bits, prefix, size) {
  const shift = BigInt(128 - size);
  return bits >> shift === prefix >> shift;
}

/** Loopback, private, link-local, multicast and reserved space — all refused. */
export function isBlockedAddress(address) {
  const clean = address.toLowerCase().replace(/^\[|\]$/g, '');

  if (clean.includes(':')) {
    // IPv4-mapped (::ffff:10.0.0.1) must be judged as the IPv4 address it wraps.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
    if (mapped) return isBlockedAddress(mapped[1]);

    const bits = v6ToBits(clean);
    if (bits === null) return true;
    const blocked = [
      ['::', 128], // unspecified
      ['::1', 128], // loopback
      ['64:ff9b::', 96], // NAT64
      ['100::', 64], // discard-only
      ['2001:db8::', 32], // documentation
      ['2002::', 16], // 6to4
      ['fc00::', 7], // unique local
      ['fe80::', 10], // link-local
      ['ff00::', 8], // multicast
    ];
    for (const [prefix, size] of blocked) {
      const reference = v6ToBits(prefix);
      if (reference !== null && inPrefixV6(bits, reference, size)) return true;
    }
    return false;
  }

  const value = v4ToInt(clean);
  if (value === null) return true;
  return BLOCKED_V4.some(([network, size]) => {
    const base = v4ToInt(network);
    const mask = size === 0 ? 0 : (~0 << (32 - size)) >>> 0;
    return base !== null && (value & mask) === (base & mask);
  });
}

/**
 * URL policy for the fetch server: scheme allowlist, address checks against
 * every resolved record (so a DNS round-robin cannot slip one through) and an
 * explicit private-address exception list for trusted internal hosts.
 */
export class UrlPolicy {
  constructor({
    allowHttp = false,
    allowPrivate = [],
    maxRedirects = 3,
    maxBytes = 1_048_576,
    timeoutMs = 20_000,
  } = {}) {
    this.allowHttp = Boolean(allowHttp);
    this.allowPrivate = allowPrivate.map((entry) => entry.toLowerCase());
    this.maxRedirects = maxRedirects;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
  }

  #privateAllowed(hostname) {
    return this.allowPrivate.some(
      (entry) => hostname === entry || hostname.endsWith(`.${entry}`) || entry === '*',
    );
  }

  /**
   * Validate a URL and return the addresses it resolves to. `addresses` is
   * pinned into the connection, which removes the DNS-rebinding window between
   * the check and the request.
   */
  async check(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      throw new PolicyError(`Not a valid URL: ${rawUrl}`, 'bad_request');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PolicyError(`Refused scheme "${url.protocol}" — only http(s) is supported.`);
    }
    if (url.protocol === 'http:' && !this.allowHttp) {
      throw new PolicyError('Plain http is disabled; enable it explicitly to allow it.');
    }
    if (url.username || url.password) {
      throw new PolicyError('Credentials must not be embedded in the URL.');
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const exception = this.#privateAllowed(hostname);

    let addresses;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      addresses = [hostname];
    } else {
      try {
        const records = await dns.lookup(hostname, { all: true, verbatim: true });
        addresses = [...new Set(records.map((record) => record.address))];
      } catch (error) {
        throw new PolicyError(`Could not resolve ${hostname}: ${error.code ?? error.message}`, 'dns');
      }
    }

    if (addresses.length === 0) throw new PolicyError(`Could not resolve ${hostname}.`, 'dns');
    if (!exception) {
      const blocked = addresses.filter((address) => isBlockedAddress(address));
      if (blocked.length > 0) {
        throw new PolicyError(
          `Refused ${hostname}: resolves to a non-public address (${blocked.join(', ')}). ` +
            'Add it to allowPrivate only if you trust it.',
        );
      }
    }

    return { url, hostname, addresses, private: exception };
  }
}

/**
 * Build the `lookup` callback that pins an already-validated address into the
 * socket (closes the DNS-rebinding window between the check and the request).
 *
 * Node calls `lookup` in two shapes: `(host, options, cb)` with `options.all`
 * set expects an array of `{address, family}`, otherwise a bare `address` plus
 * `family`. Both are handled here — getting this wrong breaks https entirely.
 */
export function pinnedLookup(addresses) {
  const records = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));

  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options && options.all) {
      callback(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
}

/* ── text ────────────────────────────────────────────────────────────────── */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  reg: '®',
  copy: '©',
};

export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

/** Readable text from HTML, with the script/style content removed first. */
export function htmlToText(html) {
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(stripped)
    .replace(/<\/?[a-z][^>]{0,400}>/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

export function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}
