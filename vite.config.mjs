import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// The renderer is built ahead of time and loaded from disk with loadFile, so
// base has to be relative: Electron serves it over file://.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/renderer/ui', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('./build/renderer', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
