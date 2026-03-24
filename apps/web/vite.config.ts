import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    conditions: ['source'],
  },
  ssr: {
    resolve: {
      conditions: ['source'],
    },
  },
  build: {
    target: 'esnext',
    cssMinify: 'lightningcss',
    rolldownOptions: isSsrBuild
      ? {}
      : {
          output: {
            manualChunks(id: string) {
              if (
                id.includes('node_modules/react-dom') ||
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-router-dom')
              ) {
                return 'react-vendor';
              }
              if (id.includes('node_modules/firebase')) {
                return 'firebase-vendor';
              }
            },
          },
        },
  },
  server: {
    port: 12412,
    strictPort: false,
  },
}));
