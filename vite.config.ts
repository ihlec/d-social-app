// vite.config.ts

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'src': path.resolve(__dirname, './src'),
      // CJS-only package imported as ESM default by hamt-sharding (Helia unixfs)
      'sparse-array': path.resolve(__dirname, './src/shims/sparse-array.js'),
    },
  },
  base: '',
  optimizeDeps: {
    // Prebundle Helia stack so nested CJS deps get interop transforms
    include: [
      'helia',
      '@helia/http',
      '@helia/libp2p',
      '@helia/bitswap',
      '@helia/unixfs',
      '@helia/ipns',
      '@ipshipyard/keychain',
      'blockstore-idb',
      'datastore-idb',
      'hamt-sharding',
      'sparse-array',
      'trystero',
    ],
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /sparse-array/],
    },
  },
})
