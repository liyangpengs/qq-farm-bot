import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia } = require('pinia')
const ts = require('typescript')

test('邮箱时刻可读取和保存，午夜与旧配置默认值正确，账号切换不串值', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const accounts = { a: { emailClaimHour: 0 }, b: { emailClaimHour: 17 }, legacy: {} }
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

  await store.fetchSettings('a')
  assert.equal(store.settings.emailClaimHour, 0)
  assert.equal((await store.saveSettings('a', { emailClaimHour: 23 })).ok, true)
  assert.equal(store.settings.emailClaimHour, 23)
  assert.deepEqual(posts[0], { url: '/api/settings/save', body: { emailClaimHour: 23 }, accountId: 'a' })

  release = null
  const pending = store.saveSettings('a', { emailClaimHour: 1 })
  await store.fetchSettings('b')
  assert.equal(store.settings.emailClaimHour, 17)
  release()
  await pending
  assert.equal(store.settings.emailClaimHour, 17, '旧账号保存响应不覆盖新账号')
  await store.fetchSettings('legacy')
  assert.equal(store.settings.emailClaimHour, 10)
})
