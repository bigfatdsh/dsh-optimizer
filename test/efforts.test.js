/**
 * 档位落地：桶 → 该模型真实支持的档位。
 *
 * 最关键的一条不变量：**输出必须落在 available 里**。落到外面宿主会直接抛
 * `UNSUPPORTED_REASONING_EFFORT`，也就是"选错档位 = 这次回答失败"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUCKETS, classifyText } from '../lib/classify.js'
import { afford, ladder, resolveEffort } from '../lib/efforts.js'

/** DeepSeek 目录里的真实形状。 */
const DEEPSEEK = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ],
  defaultEffort: 'high',
}

/** 两档模型（很多第三方供应方只有 low/high）。 */
const TWO = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }

/** 三档。 */
const THREE = { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' }

/** 认不出名字的档位：只能按声明顺序排。 */
const ODD = { efforts: [{ id: 'quick', name: 'Quick' }, { id: 'deep', name: 'Deep' }] }

test('阶梯按"省→费"排序，与声明顺序无关', () => {
  assert.deepEqual(ladder({ efforts: [...DEEPSEEK.efforts].reverse() }).map((level) => level.id), ['off', 'low', 'high', 'max'])
  assert.deepEqual(ladder(TWO).map((level) => level.id), ['low', 'high'])
  assert.deepEqual(ladder(ODD).map((level) => level.id), ['quick', 'deep'])
})

test('模型不支持推理时阶梯为空', () => {
  assert.deepEqual(ladder(undefined), [])
  assert.deepEqual(ladder(false), [])
  assert.deepEqual(ladder({ efforts: [] }), [])
  assert.deepEqual(ladder({ efforts: [{ name: '没有 id' }] }), [])
})

test('重复 id 只算一次', () => {
  assert.deepEqual(ladder({ efforts: [{ id: 'low' }, { id: 'low' }, { id: 'high' }] }).map((l) => l.id), ['low', 'high'])
})

test('DeepSeek 四档：闲聊最省、轻活低档、中活高档、重活顶格', () => {
  const levels = ladder(DEEPSEEK)
  assert.equal(afford(levels, 'quiet'), 'off')
  assert.equal(afford(levels, 'light'), 'low')
  assert.equal(afford(levels, 'standard'), 'high')
  assert.equal(afford(levels, 'heavy'), 'max')
})

test('三档与两档自动合并', () => {
  // 三档：轻活到中间档，中活与重活共享顶档（只有三档时不该把中活压到低档）。
  assert.deepEqual(['quiet', 'light', 'standard', 'heavy'].map((b) => afford(ladder(THREE), b)), ['low', 'medium', 'medium', 'high'])
  assert.deepEqual(['quiet', 'light', 'standard', 'heavy'].map((b) => afford(ladder(TWO), b)), ['low', 'low', 'high', 'high'])
})

test('任何桶、任何目录，产出都必须在 available 里', () => {
  const catalogs = [DEEPSEEK, TWO, THREE, ODD, { efforts: [{ id: 'only' }] }]
  for (const catalog of catalogs) {
    const ids = ladder(catalog).map((level) => level.id)
    for (const bucket of BUCKETS) {
      const decided = resolveEffort({ bucket, reasoning: catalog })
      assert.ok(ids.includes(decided.effort), `${bucket} → ${decided.effort} 不在 ${ids.join('/')}`)
    }
  }
})

test('认不出档位时不抛错，退回原样', () => {
  assert.deepEqual(resolveEffort({ bucket: 'heavy', reasoning: undefined }), { effort: undefined, levels: [], source: 'none' })
  assert.equal(resolveEffort({ bucket: 'heavy', reasoning: false }).effort, undefined)
})

test('force 优先，但该模型不支持时忽略', () => {
  assert.equal(resolveEffort({ bucket: 'quiet', reasoning: DEEPSEEK, forced: 'max' }).effort, 'max')
  assert.equal(resolveEffort({ bucket: 'quiet', reasoning: DEEPSEEK, forced: 'minimal' }).effort, 'off')
  assert.equal(resolveEffort({ bucket: 'quiet', reasoning: DEEPSEEK, forced: 'minimal' }).source, 'bucket')
})

test('判定表里的每句话都能落成一个真档位（端到端串一遍）', () => {
  const samples = ['你好', '什么是防抖', '帮我改一下这个函数', '帮我从零搭建一套订单系统的架构设计，要考虑分库分表和缓存策略']
  for (const text of samples) {
    const decided = resolveEffort({ bucket: classifyText(text), reasoning: DEEPSEEK })
    assert.ok(['off', 'low', 'high', 'max'].includes(decided.effort), `${text} → ${decided.effort}`)
  }
})
