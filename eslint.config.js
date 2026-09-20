const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }]
    }
  },
  {
    files: ['public/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.browser,
        L: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module' }
  },
  {
    files: ['public/**/sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.serviceworker
      }
    }
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    }
  },
  prettierConfig,
  {
    ignores: ['node_modules/', 'public/vendor/']
  }
];
