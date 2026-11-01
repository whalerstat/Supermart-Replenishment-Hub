import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '.claude/**',
      '**/.next/**',
      '**/coverage/**',
      'client/dist/**',
      '**.databricks/**',
    ],
  },

  // Base JavaScript config
  js.configs.recommended,

  // TypeScript config for all TS files
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React config for client-side files
  {
    files: ['client/**/*.{ts,tsx}', '**/*.tsx'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'react-refresh': reactRefreshPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/prop-types': 'off', // Using TypeScript for prop validation
      'react/no-array-index-key': 'warn',
    },
  },

  // Node.js specific config for server files
  {
    files: ['server/**/*.ts', '*.config.{js,ts}'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  // Disable type-checking for JS config files and standalone config files
  {
    files: ['**/*.js', '*.config.ts', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Retail demo chassis files that sit outside the two TS projects (tsconfig.server.json and
  // tsconfig.client.json): scripts/*.mjs runs under plain Node, tests/ is the Playwright smoke test
  // that `databricks apps validate` runs, and variants/ holds a drop-in replacement for
  // server/server.ts whose imports resolve from server/. Lint them without type information.
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.ts', 'variants/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },

  // Prettier config (must be last to override other formatting rules)
  prettier,

  // Custom rules
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
