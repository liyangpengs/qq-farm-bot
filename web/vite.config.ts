import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const webPackageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const analyzeBuild = mode === 'analyze'
  const compressedBuild = mode === 'compressed'
  const builtAt = Date.now()
  const webBuildId = command === 'build'
    ? `${webPackageJson.version}-${builtAt.toString(36)}-${crypto.randomBytes(4).toString('hex')}`
    : 'dev'

  return {
    plugins: [
      UnoCSS() as any,
      vue(),
      {
        name: 'panel-version-manifest',
        apply: 'build' as const,
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({
              buildId: webBuildId,
              inputHash: process.env.TURBO_HASH,
              appVersion: webPackageJson.version,
              builtAt,
            }, null, 2),
          })
        },
      },
      ...(compressedBuild
        ? [viteCompression({
            verbose: true,
            threshold: 10240,
            algorithm: 'gzip',
            ext: '.gz',
          })]
        : []),
      ...(analyzeBuild
        ? [visualizer({
            open: false,
            gzipSize: true,
            brotliSize: true,
          })]
        : []),
    ],
    build: {
      // Compressed-size reporting and bundle analysis are useful on demand,
      // but add avoidable CPU work to every Linux/Docker startup build.
      reportCompressedSize: analyzeBuild,
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
      __APP_VERSION__: JSON.stringify(webPackageJson.version),
      __WEB_BUILD_ID__: JSON.stringify(webBuildId),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/socket.io': {
          target: 'http://localhost:3007',
          changeOrigin: true,
          ws: true,
        },
        '/api': {
          target: 'http://localhost:3007',
          changeOrigin: true,
        },
        '/game-config': {
          target: 'http://localhost:3007',
          changeOrigin: true,
        },
      },
    },
  }
})
