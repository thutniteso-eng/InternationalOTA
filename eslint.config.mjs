import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['tools/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['packages/money/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'parseFloat is forbidden in packages/money. Use bigint or Decimal.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is forbidden in packages/money.',
        },
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Number(...) conversions are forbidden for monetary amounts in packages/money.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='round']",
          message: 'Math.round is forbidden in packages/money. Use explicit RoundingMode on integers/bigints.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='floor']",
          message: 'Math.floor is forbidden in packages/money. Use explicit RoundingMode on integers/bigints.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='ceil']",
          message: 'Math.ceil is forbidden in packages/money. Use explicit RoundingMode on integers/bigints.',
        },
        {
          selector: "TSPropertySignature[key.name=/amount/i] TSTypeAnnotation TSNumberKeyword",
          message: 'Use bigint for monetary amounts, number is forbidden.',
        },
        {
          selector: "PropertyDefinition[key.name=/amount/i] TSTypeAnnotation TSNumberKeyword",
          message: 'Use bigint for monetary amounts, number is forbidden.',
        },
        {
          selector: "Identifier[name=/amount/i] > TSTypeAnnotation TSNumberKeyword",
          message: 'Use bigint for monetary amounts, number is forbidden.',
        },
      ],
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'eslint.config.mjs',
      '**/vitest.config.ts',
      '**/next.config.mjs',
    ],
  },
);
