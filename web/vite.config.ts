/// <reference types="vitest/config" />
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// M19: what pdf.js fetches on demand — standard fonts, CMaps, ICC profiles and the JS fallbacks of its image
// decoders — served from this origin under /pdfjs/ (in development from node_modules, in a build copied into dist).
// WebAssembly is left out: the reader runs pdf.js with `useWasm: false` (the server's CSP has no 'wasm-unsafe-eval'),
// and so is QuickJS (PDF scripting is never enabled).
const PDFJS = join(import.meta.dirname, 'node_modules/pdfjs-dist')
const PDFJS_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs']
const pdfjsFile = (dir: string, name: string) =>
  PDFJS_DIRS.includes(dir) && /^[\w.-]+$/.test(name) && !name.endsWith('.wasm') && !/quickjs/i.test(name)
const PDFJS_TYPES: Record<string, string> = { '.js': 'text/javascript', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile' }

function pdfjsAssets(): Plugin {
  return {
    name: 'infall-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/([a-z_]+)\/([^/?#]+)/.exec(req.url ?? '')
        if (!m || !pdfjsFile(m[1]!, m[2]!)) return next()
        try {
          const body = readFileSync(join(PDFJS, m[1]!, m[2]!))
          const ext = /\.[a-z]+$/.exec(m[2]!)?.[0] ?? ''
          res.setHeader('Content-Type', PDFJS_TYPES[ext] ?? 'application/octet-stream')
          res.end(body)
        } catch {
          next()
        }
      })
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of readdirSync(join(PDFJS, dir))) {
          if (!pdfjsFile(dir, name)) continue
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(PDFJS, dir, name)) })
        }
      }
    },
  }
}

// In development the UI runs on :5173 and talks to qoop-server on :8787.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false, ws: true },
      // The AI tool endpoint, so the command shown on the AI access screen works in development too.
      '/mcp': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      // The sandboxed host page for Visuals: it must come from the server, with the server's headers.
      '/visual-frame': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
