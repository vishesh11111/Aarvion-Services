import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every test file loads `config/env`, which exits the process on an invalid
    // configuration. These values only need to be well-formed, not real.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/aarvion_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-chars-xx',
      LOG_LEVEL: 'silent',
      GEMINI_API_KEY: '',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Bootstrap, generated types and wiring have no branches worth asserting;
      // including them just dilutes the number into meaninglessness.
      exclude: [
        'src/server.ts',
        'src/worker.ts',
        'src/docs/**',
        'src/types/**',
        'src/**/*.routes.ts',
        'src/models/**',
        'src/scripts/**',
      ],
    },
  },
});
