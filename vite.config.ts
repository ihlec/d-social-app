import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'; // Ensure 'url' is imported
import path from 'path'; // Ensure 'path' is imported

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
   resolve: {
    alias: {
      // Use import.meta.url and fileURLToPath for ESM __dirname equivalent
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
   // Add build target for older browser compatibility if needed
   // build: {
   //   target: 'es2020'
   // },
   // optimizeDeps: {
   //   esbuildOptions: {
   //     target: 'es2020'
   //   }
   // }
})