import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const devHost = process.env.ATLAS_DEV_HOST || '127.0.0.1';
const devPort = Number(process.env.ATLAS_DEV_PORT || 5173);
const proxyHost = devHost === '0.0.0.0' ? '127.0.0.1' : devHost;
const apiProxyTarget =
  process.env.ATLAS_API_PROXY_TARGET || `http://${proxyHost}:3000`;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort: true,
    allowedHosts: 'all',
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
