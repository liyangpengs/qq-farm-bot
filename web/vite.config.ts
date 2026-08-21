import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const corePackageJson = JSON.parse(readFileSync('../core/package.json', 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    UnoCSS() as any,
    viteCompression({
      verbose: true,
      disable: false,
      threshold: 10240,
      algorithm: 'gzip',
      ext: '.gz',
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')
          if (!normalizedId.includes('/node_modules/'))
            return undefined

          const matchesPackage = (name: string) => normalizedId.includes(`/node_modules/${name}/`)

          if (['vue', 'vue-router', 'pinia', '@vueuse/core'].some(matchesPackage))
            return 'vendor-vue'

          if ([
            'naive-ui',
            'vueuc',
            'vdirs',
            'vooks',
            'css-render',
            '@css-render/vue3-ssr',
            '@css-render/plugin-bem',
            'seemly',
            'treemate',
            'evtd',
            'date-fns',
            'date-fns-tz',
            'lodash-es',
            'async-validator',
          ].some(matchesPackage)) {
            return 'vendor-ui'
          }

          if (matchesPackage('axios'))
            return 'vendor-axios'

          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  define: {
    __APP_VERSION__: JSON.stringify(corePackageJson.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3690',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3690',
        changeOrigin: true,
      },
      '/game-config': {
        target: 'http://localhost:3690',
        changeOrigin: true,
      },
    },
  },
})
