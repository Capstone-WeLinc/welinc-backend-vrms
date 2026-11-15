// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // Tests pass jest mocks to expect(), such as expect(res.setHeader); a mock is not a real method,
  // so unbound-method only raises false alarms there (typescript-eslint's own advice)
  {
    files: ['src/**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // Spec 0010, AC-11: app code reads settings through ConfigService<Env, true>, never process.env
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/config/env.ts',
      'src/config/check-env.ts',
      'src/config/test-env.setup.ts',
      'src/**/*.spec.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read settings through ConfigService<Env, true> (src/config/env.ts, spec 0010).',
        },
      ],
    },
  },
);
