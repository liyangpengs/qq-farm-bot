import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia } = require('pinia')
const ts = require('typescript')

test('farm and ranch illustrated switches save independently for the selected account', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const accounts = {
    farm: { automation: { farm_illustrated: true, ranch_illustrated: false } },
    ranch: { automation: { farm_illustrated: false, ranch_illustrated: true } },
  }
  const posts = []
  let release
  const api = {
    get: async (_url, options) => ({ data: { ok: true, data: accounts[options.headers['x-account-id']] } }),
    post: async (url, body, options) => {
      posts.push({ url, body, accountId: options.headers['x-account-id'] })
      if (release === null)
        await new Promise(resolve => release = resolve)
      return { data: { ok: true, data: body } }
    },
  }
  const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => id === '@/api'
    ? { __esModule: true, default: api, getApiErrorMessage: value => value.error }
    : require(id), module, module.exports)
  const store = module.exports.useSettingStore(pinia)

  await store.fetchSettings('farm')
  assert.deepEqual({ ...store.settings.automation }, accounts.farm.automation)
  const automation = { farm_illustrated: false }
  await store.saveSettings('farm', { automation })
  assert.deepEqual(posts[0], { url: '/api/settings/save', body: { automation }, accountId: 'farm' })

  release = null
  const pending = store.saveSettings('farm', { automation: { farm_illustrated: true } })
  await store.fetchSettings('ranch')
  assert.deepEqual({ ...store.settings.automation }, accounts.ranch.automation)
  release()
  await pending
  assert.deepEqual({ ...store.settings.automation }, accounts.ranch.automation, 'late response from the prior account must not overwrite the selected switches')
})
