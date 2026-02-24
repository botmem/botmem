import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        proxy: {
            '/api': 'http://localhost:3001',
            '/events': {
                target: 'http://localhost:3001',
                ws: true,
            },
        },
    },
});
//# sourceMappingURL=vite.config.js.map