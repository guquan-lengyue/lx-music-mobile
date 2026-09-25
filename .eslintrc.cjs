const baseRule = {
  'no-new': 'off',
  camelcase: 'off',
  'no-return-assign': 'off',
  'space-before-function-paren': ['error', 'never'],
  'no-var': 'error',
  'no-fallthrough': 'off',
  eqeqeq: 'off',
  'require-atomic-updates': ['error', { allowProperties: true }],
  'no-multiple-empty-lines': [1, { max: 2 }],
  'comma-dangle': [2, 'always-multiline'],
  'standard/no-callback-literal': 'off',
  'prefer-const': 'off',
  'no-labels': 'off',
  'node/no-callback-literal': 'off',
  'multiline-ternary': 'off',
  'react/display-name': 'off',
  'react/prop-types': 'off',
}

module.exports = {
  root: true,
  extends: [
    'standard',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react/jsx-runtime',
  ],
  plugins: [
    'react',
  ],
  rules: baseRule,
  parser: '@babel/eslint-parser',
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      extends: ['standard-with-typescript'],
      rules: {
        ...baseRule,
        '@typescript-eslint/strict-boolean-expressions': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/space-before-function-paren': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/restrict-template-expressions': [
          1,
          {
            allowBoolean: true,
          },
        ],
        '@typescript-eslint/no-misused-promises': [
          'error',
          {
            checksVoidReturn: {
              arguments: false,
              attributes: false,
            },
          },
        ],
        '@typescript-eslint/naming-convention': 'off',
        '@typescript-eslint/return-await': 'off',
        '@typescript-eslint/comma-dangle': 'off',
        '@typescript-eslint/no-dynamic-delete': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/ban-types': 'off',
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    {
      // 上游既有技术债，本分支未改动这两个文件，为不越界修改源码而在此豁免：
      //   src/core/music/utils.ts:445,480 多余的 `as any`（上游 TODO 已标注待清理）
      //   src/utils/common.ts:74 连续 3 个空行
      // 待上游清理后应删除本 override。
      files: ['src/core/music/utils.ts', 'src/utils/common.ts'],
      rules: {
        '@typescript-eslint/no-unnecessary-type-assertion': 'off',
        'no-multiple-empty-lines': 'off',
      },
    },
  ],
  settings: {
    react: {
      version: 'detect', // React version. "detect" automatically picks the version you have installed.
      // You can also use `16.0`, `16.3`, etc, if you want to override the detected value.
      // It will default to "latest" and warn if missing, and to "detect" in the future
    },
  },
  ignorePatterns: [
    'node_modules',
    '*.min.js',
    'test.js',
    '*Test.ts',
    // docs 存放设计文档与离线值守脚本，非随 App 发布的源码
    'docs',
  ],
}
