import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// Runtime deps (incl. native node-pty / better-sqlite3) load from node_modules, never bundled.
const external = ['electron', ...Object.keys(pkg.dependencies), /^node:/, /^@modelcontextprotocol\/sdk\//, /^electron-native-speech\//]

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        external,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          daemon: resolve(__dirname, 'src/daemon/index.ts'),
          'mcp-shim': resolve(__dirname, 'src/daemon/mcp/shim.ts'),
          ptyhost: resolve(__dirname, 'src/daemon/ptyhost/host.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: { externalizeDeps: true, rollupOptions: { external, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { ...alias, '@r': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
