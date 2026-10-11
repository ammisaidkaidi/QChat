import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.vitest/**'],
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
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
