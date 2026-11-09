import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const source = readFileSync(new URL('../src/utils/hour-of-day.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const exports = {}
// eslint-disable-next-line no-new-func
new Function('exports', outputText)(exports)
const { parseHourOfDay } = exports

test('hours accept midnight and 23 but reject empty, decimal, nonnumeric and out-of-range drafts', () => {
  for (const hour of [0, 10, 23, '0', '10', '23'])
    assert.equal(parseHourOfDay(hour), Number(hour))
  for (const value of [-1, 24, 1.5, '', ' ', '10.5', '10abc', '1e1', '0x10', null, undefined, true, [], {}, Infinity, Number.NaN])
    assert.equal(parseHourOfDay(value), null)
})
