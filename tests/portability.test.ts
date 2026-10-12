import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * npm runs a script through `sh` on Linux and macOS but through `cmd.exe` on
 * Windows, and `cmd.exe` has no `#` comment: a trailing `# note` is passed to
 * the program as arguments. `vite build # build the interface` therefore
 * becomes `vite build "#" build the interface`, and Vite takes `#` as the
 * project root — "Could not resolve entry module \"#/index.html\"".
 *
 * `$(cmd)` and backtick substitutions are POSIX-only for the same reason, and
 * `;` does not separate commands in cmd.exe. None of it belongs in a script
 * that has to run on a developer's machine; these checks keep it out.
 */
const SHELL_ONLY = /#|\$\(|`|;/;

const root = process.cwd();
const packages = ['package.json', 'ui/package.json', 'scripts/package.json'];

function scriptsOf(file: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

describe('npm scripts stay portable', () => {
  for (const file of packages) {
    it(`${file} uses no shell-only syntax`, () => {
      for (const [name, command] of Object.entries(scriptsOf(file))) {
        expect(SHELL_ONLY.test(command), `${file} → ${name}: ${command}`).toBe(false);
      }
    });
  }

  it('keeps the scripts a fresh clone needs', () => {
    const root = scriptsOf('package.json');
    expect(Object.keys(root)).toEqual(
      expect.arrayContaining([
        'build',
        'build:all',
        'verify',
        'ui:install',
        'ui:build',
        'postinstall',
      ]),
    );
    expect(scriptsOf('ui/package.json')).toHaveProperty('prebuild');
    expect(scriptsOf('ui/package.json')).toHaveProperty('build');
  });
});
