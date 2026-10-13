import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // Ignore build artifacts and dependencies.
  { ignores: ['client/dist/**', 'node_modules/**'] },

  // Node.js server files.
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        process: true,
        Buffer: true,
        __dirname: true,
        __filename: true,
        module: true,
        require: true,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Client-side files (browser globals).
  {
    files: ['client/src/**/*.jsx', 'client/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
        React: true,
        JSX: true,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Security-critical rules across the project.
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-var': 'warn',
    },
  },
];
