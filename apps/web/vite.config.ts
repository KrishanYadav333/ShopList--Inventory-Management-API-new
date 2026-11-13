import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately (`npm run dev:api`); proxy /api to it so cookies stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  build: { sourcemap: true, chunkSizeWarningLimit: 400 },
});
