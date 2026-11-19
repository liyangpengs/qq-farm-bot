import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia } = require('pinia')
const ts = require('typescript')

test('集市两种兑换开关分别读取和保存，切换账号不串值', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const accounts = {
    a: { automation: { ranch_market_organic_poop: true, ranch_market_organic_pinecone: false } },
    b: { automation: { ranch_market_organic_poop: false, ranch_market_organic_pinecone: true } },
  }
  const posts = []
  let release
  const api = {
    get: async (_url, options) => ({ data: { ok: true, data: accounts[options.headers['x-account-id']] } }),
    post: async (url, body, options) => {
      posts.push({ url, body, accountId: options.headers['x-account-id'] })
      if (release === null)
        await new Promise(resolve => release = resolve)
      accounts[options.headers['x-account-id']] = structuredClone(body)
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
  await store.fetchSettings('a')
  assert.equal(store.settings.automation.ranch_market_organic_poop, true)
  assert.equal(store.settings.automation.ranch_market_organic_pinecone, false)
  for (const poop of [false, true]) {
    for (const pinecone of [false, true]) {
      const automation = { ranch_market_organic_poop: poop, ranch_market_organic_pinecone: pinecone }
      assert.equal((await store.saveSettings('a', { automation })).ok, true)
      assert.deepEqual(posts.at(-1).body, { automation })
      await store.fetchSettings('a')
      assert.deepEqual({ ...store.settings.automation }, automation)
    }
  }
  release = null
  const pending = store.saveSettings('a', { automation: { ranch_market_organic_poop: true, ranch_market_organic_pinecone: false } })
  await store.fetchSettings('b')
  release()
  await pending
  assert.equal(store.settings.automation.ranch_market_organic_poop, false)
  assert.equal(store.settings.automation.ranch_market_organic_pinecone, true)
})
