import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Lint rules.
 *
 * Kept deliberately small. TypeScript's compiler already catches the class of
 * problems most lint rules target, and a 300-rule config mostly generates noise
 * that teams learn to ignore. What is here catches things `tsc` does not:
 * floating promises, unsafe `any` leaks, and accidental `console.log`.
 *
 * Formatting is not linted at all — that is Prettier's job, and arguing about it
 * in review is wasted time.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        globalThis: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Unused variables are usually a leftover or a typo. The underscore
      // prefix is the escape hatch for deliberately ignored arguments.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // An un-awaited promise in a request handler is a silently swallowed
      // error and, often, a response that never arrives.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // Logging goes through pino so it is structured, redacted and levelled.
      'no-console': ['warn', { allow: ['error', 'warn'] }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',

      // The TS-aware version understands declaration merging; the base rule
      // reports false positives on it.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': ['error', { ignoreDeclarationMerge: true }],

      // Handled by @typescript-eslint's equivalents.
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  {
    /*
     * `models/enums.ts` deliberately declares a value and a type of the same
     * name for each enum:
     *
     *     export const Role = { OWNER: 'OWNER', ... } as const;
     *     export type  Role = (typeof Role)[keyof typeof Role];
     *
     * This is the standard TypeScript idiom for a string enum that erases to
     * plain strings at runtime — which is what we want stored in MongoDB. It is
     * intentional, not a shadowing bug, and TypeScript itself would reject an
     * actual redeclaration, so the rule adds nothing here.
     */
    files: ['src/models/enums.ts'],
    rules: { '@typescript-eslint/no-redeclare': 'off' },
  },
  {
    // Tests and CLI scripts legitimately print to stdout — their output is the
    // point, unlike a service that should be emitting structured logs.
    files: ['tests/**/*.ts', 'src/seed.ts', 'src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
