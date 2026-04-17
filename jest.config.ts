import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup/chrome-mock.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/manifest.json',
    '<rootDir>/src/_locales/',
    '<rootDir>/src/icons/',
    '<rootDir>/src/styles/',
    // エントリは起動フックのみで、本体は *_bootstrap.ts 側でテストする
    '<rootDir>/src/popup/popup.ts',
    '<rootDir>/src/app/app.ts',
    '<rootDir>/src/options/options.ts',
    '<rootDir>/src/background/service-worker.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
};

export default config;
