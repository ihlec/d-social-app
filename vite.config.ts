// vite.config.ts

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url';
import path from 'path';

// Define the directory name equivalent for ESM context
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
   resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'), 
      'src': path.resolve(__dirname, './src'), 
    },
  },
  base: ''
})