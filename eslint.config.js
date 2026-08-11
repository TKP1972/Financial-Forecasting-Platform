import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/api/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      // Money must never be a float. Guardrail, not a substitute for review.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Use Money/Decimal helpers from @ffp/shared instead of parseFloat for monetary values.',
        },
      ],
      // Each of the following is a trap recorded in CLAUDE.md that has already
      // cost real debugging time. A documented convention decays; a lint rule
      // does not.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'decimal.js',
              importNames: ['default'],
              message:
                "Use the named import: import { Decimal } from 'decimal.js'. Under NodeNext the default import resolves to the module namespace, not the class.",
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.object.name='z'][callee.object.property.name='coerce'][callee.property.name='boolean']",
          message:
            'z.coerce.boolean() applies JS truthiness, so the string "false" becomes true. Use queryBoolean from @ffp/shared.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    // Repo tooling runs on Node directly rather than through the TypeScript
    // build, so it needs the Node globals declared.
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        // Node 22 provides these globally; the e2e runner and journey suite use
        // them rather than pulling in a HTTP client dependency.
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  prettier,
);
