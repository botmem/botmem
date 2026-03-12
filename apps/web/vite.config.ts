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
    rollupOptions: isSsrBuild
      ? {}
      : {
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom', 'react-router-dom'],
              'firebase-vendor': ['firebase/app', 'firebase/auth'],
            },
          },
        },
  },
  server: {
    port: 12412,
    strictPort: false,
  },
}));
