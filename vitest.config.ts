import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', include: ['src/**/*.test.ts'] } },
      { test: { name: 'domain', root: 'packages/domain', include: ['src/**/*.test.ts'], passWithNoTests: true } },
      { test: { name: 'mock-systems', root: 'apps/mock-systems', include: ['src/**/*.test.ts'], passWithNoTests: true } },
      { test: { name: 'server', root: 'apps/server', include: ['src/**/*.test.ts'], passWithNoTests: true } },
      { test: { name: 'scripts', root: 'scripts', include: ['eval/**/*.test.ts'], passWithNoTests: true } },
      { test: { name: 'web', root: 'apps/web', include: ['src/**/*.test.ts'], passWithNoTests: true } },
    ],
  },
});
