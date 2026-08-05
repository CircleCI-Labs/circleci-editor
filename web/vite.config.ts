/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Extracts the npm package name (scope included) that a Rollup module id
 * belongs to, e.g. `.../node_modules/@codemirror/state/dist/index.js` ->
 * `@codemirror/state`. Understands pnpm's nested `.pnpm/<name>@<version>/
 * node_modules/<name>/...` layout, so it works whether or not `id` has been
 * resolved through a pnpm symlink. Returns `null` for app code / virtual
 * modules that aren't under any `node_modules`.
 */
function nodeModulesPackageName(id: string): string | null {
  const marker = 'node_modules/';
  let idx = id.lastIndexOf(marker);
  if (idx === -1) return null;

  let rest = id.slice(idx + marker.length);
  // pnpm nests the real package one level deeper inside its own
  // node_modules, e.g. `.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/
  // react-dom/...` -- unwrap to the innermost `node_modules/` segment.
  if (rest.startsWith('.pnpm/')) {
    idx = rest.lastIndexOf(marker);
    if (idx === -1) return null;
    rest = rest.slice(idx + marker.length);
  }

  const [first, second] = rest.split('/');
  if (!first) return null;
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../internal/webassets/dist',
    // Deliberately false: the output directory contains a committed .gitkeep
    // that keeps the Go go:embed directive valid on a fresh clone, and
    // emptying the directory would delete it. The prebuild script removes
    // the previous bundle instead, so stale hashed assets do not accumulate.
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // CodeMirror, React Flow and elkjs are all sizeable and mostly
        // independent of one another and of app code, so without this the
        // default single vendor chunk trips Rollup's 500kB warning. Group by
        // *package name* (parsed out of the module id) rather than matching
        // version-pinned path fragments, so a dependency version bump can't
        // silently drop a package back into the catch-all chunk.
        manualChunks(id) {
          const pkg = nodeModulesPackageName(id);
          if (!pkg) return undefined;

          if (
            pkg === 'codemirror' ||
            pkg === '@uiw/react-codemirror' ||
            pkg === '@uiw/codemirror-extensions-basic-setup' ||
            pkg.startsWith('@codemirror/') ||
            pkg.startsWith('@lezer/')
          ) {
            return 'codemirror';
          }
          if (pkg.startsWith('@xyflow/')) return 'reactflow';
          if (pkg === 'elkjs') return 'elk';
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler')
            return 'react';
          if (pkg === 'yaml' || pkg === 'diff') return 'yaml';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // Scope Vitest to unit tests under src. Without this it also globs
    // e2e/*.spec.ts, which are Playwright specs: they call Playwright's
    // test.describe, which throws when executed by Vitest. Those run
    // separately via `pnpm test:e2e`.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
