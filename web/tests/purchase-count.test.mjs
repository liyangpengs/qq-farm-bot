import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/purchase-count.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const module = { exports: {} }
new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
const { affordableCount, purchaseMaxCount } = module.exports

test('affordableCount takes the minimum across costs as floor(balance/price)', () => {
  // 券 100 张、喇叭 3 个：min(100/10, 3/1) = 3
  assert.equal(affordableCount([
    { id: 1041, count: 10, balance: 100 },
    { id: 1042, count: 1, balance: 3 },
  ]), 3)
  // 单一货币刚好整除：floor(100/20) = 5
  assert.equal(affordableCount([{ id: 1041, count: 20, balance: 100 }]), 5)
  // 不整除时向下取整：floor(99/20) = 4
  assert.equal(affordableCount([{ id: 1041, count: 20, balance: 99 }]), 4)
  // 余额不足以买一份：0
  assert.equal(affordableCount([{ id: 1041, count: 20, balance: 19 }]), 0)
  assert.equal(affordableCount([{ id: 1041, count: 20, balance: 0 }]), 0)
})

test('affordableCount treats invalid or unknown-balance costs as unconstrained', () => {
  // 余额未知的费用不参与约束，仅由已知费用决定
  assert.equal(affordableCount([
    { id: 1041, count: 10, balance: 50 },
    { id: 1004, count: 1, balance: null },
  ]), 5)
  // 单价无效（<=0）不参与约束
  assert.equal(affordableCount([
    { id: 1041, count: 10, balance: 50 },
    { id: 1004, count: 0, balance: 1 },
  ]), 5)
  // 没有任何费用参与约束（免费商品 / 余额全未知）：无余额约束
  assert.equal(affordableCount([]), Number.POSITIVE_INFINITY)
  assert.equal(affordableCount([{ id: 1041 }]), Number.POSITIVE_INFINITY)
  assert.equal(affordableCount([{ id: 1041, count: 10, balance: null }]), Number.POSITIVE_INFINITY)
})

test('purchaseMaxCount caps by limit remaining, balance and hard cap', () => {
  // 限购 10、余额只够 3：取较小值 3
  assert.equal(purchaseMaxCount({
    limitRemaining: 10,
    costs: [{ id: 1041, count: 10, balance: 35 }],
  }), 3)
  // 余额充足、限购 4：取限购
  assert.equal(purchaseMaxCount({
    limitRemaining: 4,
    costs: [{ id: 1041, count: 10, balance: 1000 }],
  }), 4)
  // 无限购（null）、余额够 7：取余额
  assert.equal(purchaseMaxCount({
    limitRemaining: null,
    costs: [{ id: 1041, count: 10, balance: 75 }],
  }), 7)
  // 免费商品（无费用、无限购）：取硬上限，不应被钳到 1
  assert.equal(purchaseMaxCount({ limitRemaining: null, costs: [] }), 9999)
  assert.equal(purchaseMaxCount({ limitRemaining: 10, costs: [] }), 10)
  // 多费用取最小可购数
  assert.equal(purchaseMaxCount({
    limitRemaining: 10,
    costs: [
      { id: 1041, count: 10, balance: 100 },
      { id: 1042, count: 3, balance: 20 },
    ],
  }), 6)
  // 余额不足一份时下限为 1（提交时有余额校验兜底）
  assert.equal(purchaseMaxCount({
    limitRemaining: 10,
    costs: [{ id: 1041, count: 100, balance: 5 }],
  }), 1)
  // 自定义硬上限
  assert.equal(purchaseMaxCount({ limitRemaining: 50, costs: [], cap: 20 }), 20)
  // 限购剩余为 0（售罄兜底）也不低于 1
  assert.equal(purchaseMaxCount({
    limitRemaining: 0,
    costs: [{ id: 1041, count: 1, balance: 100 }],
  }), 1)
})
