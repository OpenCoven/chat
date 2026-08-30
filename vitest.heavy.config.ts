import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      include: [
        'src/phase1-conformance.test.ts',
        'src/phase1-conformance-lock.test.ts',
        'src/phase1-conformance-artifact-root.test.ts',
        'src/phase1-windows-supervisor.test.ts',
      ],
      setupFiles: ['./src/test/setup.ts'],
      fileParallelism: false,
      maxWorkers: 1,
    },
  }),
);
