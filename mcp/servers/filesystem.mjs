#!/usr/bin/env node
/**
 * Hardened filesystem MCP server.
 *
 *   node mcp/servers/filesystem.mjs '{"roots":["./scripts"],"allow_write":true}'
 *
 * Config (the JSON argument, or the same keys inside `mcp.json`):
 *   roots       required — the only directories that can be touched
 *   allow_write read-only unless this is true (write_file, create_directory)
 *   allow_delete false by default; adds remove_path when true
 *   max_bytes   per-file read cap (default 1 MB)
 *   max_entries per-listing cap (default 500)
 *
 * Every path goes through PathPolicy before a syscall is made, so `..`,
 * symlink escapes, credential files and anything outside the roots are refused
 * by this process — not by asking the model nicely.
 */
import { open, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { PathPolicy } from '../lib/guards.mjs';
import { configFromArgv, serve, ToolError } from '../lib/protocol.mjs';

const config = configFromArgv();
const policy = new PathPolicy({
  roots: config.roots ?? [],
  allowWrite: config.allow_write === true,
  allowDelete: config.allow_delete === true,
});

const MAX_BYTES = Number(config.max_bytes ?? 1_048_576);
const MAX_ENTRIES = Number(config.max_entries ?? 500);
const MAX_DEPTH = Number(config.max_depth ?? 4);
const READ_ONLY_NOTE = policy.allowWrite ? '' : ' (read-only: writes are refused)';

function human(size) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function statsOf(info) {
  return {
    type: info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file',
    size_bytes: info.size,
    size: human(info.size),
    modified: new Date(info.mtimeMs).toISOString(),
    mode: `0${(info.mode & 0o777).toString(8)}`,
  };
}

async function walk(directory, depth, out) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return out;
    const full = join(directory, entry.name);
    let target;
    try {
      // Refuse anything the policy rejects while walking instead of leaking it.
      target = policy.resolvePath(full);
    } catch {
      continue;
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      continue;
    }
    out.push({
      path: full,
      name: entry.name,
      type: info.isDirectory() ? 'dir' : 'file',
      size_bytes: info.size,
      size: human(info.size),
      modified: new Date(info.mtimeMs).toISOString(),
    });
    if (info.isDirectory() && depth < MAX_DEPTH) await walk(target, depth + 1, out);
  }
  return out;
}

const tools = [
  {
    name: 'list_allowed_roots',
    description: 'Show which directories this server may touch and whether writes are enabled.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({
      roots: policy.roots,
      allow_write: policy.allowWrite,
      allow_delete: policy.allowDelete,
      max_bytes: MAX_BYTES,
      enforcement: 'paths are resolved and checked in-process; symlinks are followed before the check',
    }),
  },
  {
    name: 'list_directory',
    description: `List one directory inside the allowed roots${READ_ONLY_NOTE}.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory: absolute, or relative to the repo root (e.g. "scripts") or to the allowed root.' },
        depth: { type: 'number', description: 'Recurse this many levels (default 1, max 4).' },
        show_hidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
      },
      required: ['path'],
    },
    handler: async ({ path, depth = 1, show_hidden = false }) => {
      const target = policy.resolvePath(path);
      const info = await stat(target);
      if (!info.isDirectory()) throw new ToolError(`${path} is not a directory.`);

      const levels = Math.min(Math.max(Number(depth) || 1, 1), MAX_DEPTH);
      if (levels === 1) {
        const entries = await readdir(target, { withFileTypes: true });
        const rows = [];
        for (const entry of entries) {
          if (!show_hidden && entry.name.startsWith('.')) continue;
          if (rows.length >= MAX_ENTRIES) break;
          try {
            const child = policy.resolvePath(join(target, entry.name));
            rows.push({
              name: entry.name,
              path: join(target, entry.name),
              ...statsOf(await stat(child)),
            });
          } catch (error) {
            rows.push({ name: entry.name, path: join(target, entry.name), type: 'blocked', reason: error.message });
          }
        }
        return { path: target, count: rows.length, entries: rows };
      }

      const all = await walk(target, 1, []);
      const filtered = show_hidden ? all : all.filter((row) => !basename(row.path).startsWith('.'));
      return { path: target, depth: levels, count: filtered.length, entries: filtered.slice(0, MAX_ENTRIES) };
    },
  },
  {
    name: 'read_file',
    description: `Read a UTF-8 text file inside the allowed roots${READ_ONLY_NOTE}.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read.' },
        max_bytes: { type: 'number', description: `Cap (default ${MAX_BYTES}).` },
      },
      required: ['path'],
    },
    handler: async ({ path, max_bytes }) => {
      const target = policy.resolvePath(path);
      const info = await stat(target);
      if (info.isDirectory()) throw new ToolError(`${path} is a directory.`);

      const cap = Math.min(Number(max_bytes) || MAX_BYTES, MAX_BYTES);

      // Only the bytes that will be returned are ever read into memory.
      const handle = await open(target, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(cap, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const slice = buffer.subarray(0, bytesRead);
        if (slice.includes(0)) {
          throw new ToolError(`${path} looks binary — only UTF-8 text is returned.`);
        }
        const truncated = info.size > bytesRead;
        return {
          path: target,
          size_bytes: info.size,
          truncated,
          text: truncated ? `${slice.toString('utf8')}\n… (truncated at ${cap} bytes of ${info.size})` : slice.toString('utf8'),
        };
      } finally {
        await handle.close();
      }
    },
  },
  {
    name: 'read_multiple_files',
    description: 'Read several files at once; failures are reported per file.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
    handler: async ({ paths }) => {
      if (!Array.isArray(paths) || paths.length === 0) throw new ToolError('paths must be a non-empty array.');
      if (paths.length > 20) throw new ToolError('At most 20 files per call.');
      const files = [];
      for (const entry of paths) {
        try {
          const target = policy.resolvePath(entry);
          const info = await stat(target);
          if (info.size > MAX_BYTES) {
            files.push({ path: entry, error: `too large (${human(info.size)})` });
            continue;
          }
          files.push({ path: target, text: await readFile(target, 'utf8') });
        } catch (error) {
          files.push({ path: entry, error: error.message });
        }
      }
      return { count: files.length, files };
    },
  },
  {
    name: 'get_file_info',
    description: 'Size, type, timestamps and permissions of one path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: async ({ path }) => {
      const target = policy.resolvePath(path);
      const info = await stat(target);
      return { path: target, real_path: target, ...statsOf(info), created: new Date(info.birthtimeMs).toISOString() };
    },
  },
  {
    name: 'search_files',
    description: 'Find files by glob under a directory (name matching only, never content).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in.' },
        pattern: { type: 'string', description: 'Glob, e.g. *.py or report-?.csv.' },
        refresh: { type: 'boolean', description: 'Accepted for compatibility; results are always fresh.' },
      },
      required: ['path', 'pattern'],
    },
    handler: async ({ path, pattern }) => {
      const target = policy.resolvePath(path);
      const all = await walk(target, 1, []);
      const regex = new RegExp(
        `^${String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
        'i',
      );
      const matches = all.filter((row) => regex.test(basename(row.path)));
      return {
        path: target,
        pattern,
        count: matches.length,
        truncated: all.length >= MAX_ENTRIES,
        matches: matches.slice(0, MAX_ENTRIES),
      };
    },
  },
];

if (policy.allowWrite) {
  tools.push(
    {
      name: 'write_file',
      description: 'Write a UTF-8 file inside the allowed roots. Refused unless allow_write is on.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          mode: { type: 'string', description: 'overwrite (default) or append.' },
        },
        required: ['path', 'content'],
      },
      handler: async ({ path, content, mode = 'overwrite' }) => {
        const target = policy.resolvePath(path, { write: true });
        const info = await stat(target).catch(() => null);
        if (info?.isDirectory()) throw new ToolError(`${path} is a directory.`);
        if (mode === 'append') await writeFile(target, String(content), { flag: 'a', encoding: 'utf8' });
        else await writeFile(target, String(content), { encoding: 'utf8' });
        const after = await stat(target);
        return {
          path: target,
          mode,
          bytes_written: Buffer.byteLength(String(content), 'utf8'),
          size_bytes: after.size,
          created: info === null,
        };
      },
    },
    {
      name: 'create_directory',
      description: 'Create a directory inside the allowed roots. Refused unless allow_write is on.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory to create.' } },
        required: ['path'],
      },
      handler: async ({ path }) => {
        const target = policy.resolvePath(path, { write: true });
        await mkdir(target, { recursive: true, mode: 0o755 });
        return { path: target, created: true };
      },
    },
  );
}

if (policy.allowDelete) {
  tools.push({
    name: 'remove_path',
    description: 'Delete a file or empty directory. Refused unless allow_delete is on.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Required true for a non-empty directory.' },
      },
      required: ['path'],
    },
    handler: async ({ path, recursive = false }) => {
      const target = policy.resolvePath(path, { write: true });
      if (target === policy.roots.find((root) => target.startsWith(root))) {
        throw new ToolError('Refused: that is an allowed root itself.');
      }
      const info = await stat(target);
      if (info.isDirectory() && !recursive) {
        throw new ToolError('Refused: pass recursive:true to delete a directory.');
      }
      await rm(target, { recursive: Boolean(recursive), force: false });
      return { path: target, removed: true, was: info.isDirectory() ? 'dir' : 'file' };
    },
  });
}

serve({ name: 'infagent-filesystem', version: '1.0.0', tools });
