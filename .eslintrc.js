module.exports = {
  env: {
    es2021: true,
    node: true,
    jest: true
  },
  extends: [
    'eslint:recommended',
    'plugin:jest/recommended',
    'standard'
  ],
  parserOptions: {
    ecmaVersion: 12,
    sourceType: 'module'
  },
  plugins: [
    'jest'
  ],
  rules: {
    curly: ['error', 'all'],
    'no-console': ['error', { allow: ['info', 'warn', 'error'] }] // only intentional logs (info/warn/error); disallow console.log
  }
}
