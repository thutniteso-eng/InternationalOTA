import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Isolated test DBs install PostGIS + unaccent + pg_trgm migrations under parallel worker load.
    maxWorkers: 4,
    hookTimeout: 45_000,
    testTimeout: 45_000,
  },
  plugins: [swc.vite()],
});
