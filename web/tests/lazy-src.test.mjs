import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/directives/lazy-src.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const exports = {}
// eslint-disable-next-line no-new-func
new Function('exports', outputText)(exports)
const { vLazySrc } = exports

test('images wait for visibility, share an observer and release it after loading or unmounting', (t) => {
  const observers = []
  class Observer {
    targets = new Set()
    disconnected = false
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      observers.push(this)
    }

    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.disconnected = true }
  }
  const original = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = Observer
  t.after(() => {
    globalThis.IntersectionObserver = original
  })
  const image = () => ({ src: undefined, removeAttribute() {
    this.src = undefined
  } })
  const first = image()
  const next = image()
  vLazySrc.mounted(first, { value: '/one.png' })
  vLazySrc.mounted(next, { value: '/two.png' })
  assert.equal(observers.length, 1)
  const observer = observers[0]
  assert.equal(observer.options.rootMargin, '200px 0px')
  assert.equal(first.src, undefined)
  assert.equal(next.src, undefined)
  observer.callback([{ target: first, isIntersecting: false }])
  assert.equal(first.src, undefined)
  observer.callback([{ target: first, isIntersecting: true }])
  assert.equal(first.src, '/one.png')
  assert.equal(observer.targets.has(first), false)
  assert.equal(observer.disconnected, false)

  vLazySrc.updated(next, { value: '/changed.png', oldValue: '/two.png' })
  const active = observers.at(-1)
  active.callback([{ target: next, isIntersecting: true }])
  assert.equal(next.src, '/changed.png')
  assert.equal(active.disconnected, true)

  vLazySrc.updated(first, { value: '/replacement.png', oldValue: '/one.png' })
  assert.equal(first.src, undefined, 'a new source is deferred again')
  const waiting = observers.at(-1)
  vLazySrc.beforeUnmount(first)
  waiting.callback([{ target: first, isIntersecting: true }])
  assert.equal(first.src, undefined, 'queued callbacks must not load unmounted images')
  assert.equal(waiting.disconnected, true)
})

test('images load normally when IntersectionObserver is unavailable', (t) => {
  const original = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = undefined
  t.after(() => {
    globalThis.IntersectionObserver = original
  })
  const el = { src: undefined, removeAttribute() {
    this.src = undefined
  } }
  vLazySrc.mounted(el, { value: '/fallback.png' })
  assert.equal(el.src, '/fallback.png')
  vLazySrc.updated(el, { value: '', oldValue: '/fallback.png' })
  assert.equal(el.src, undefined)
})
