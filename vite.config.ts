import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    host: process.env.VITE_HOST ?? '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
});
