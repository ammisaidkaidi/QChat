import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `ui/**` is type-checked by vue-tsc (see ui/package.json) and `scripts/**`
    // holds agent-authored files that must not be able to fail repo lint.
    ignores: [
      'dist/**',
      'ui/**',
      'scripts/**',
      'coverage/**',
      'node_modules/**',
      '.vitest/**',
      'tools/ui-smoke.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    // The browser smoke test runs in Node *and* inside the page.
    files: ['tools/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', document: 'readonly' },
    },
  },
  {
    // The MCP servers and their helpers are plain Node .mjs modules.
    files: ['mcp/**/*.mjs', 'scripts/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
