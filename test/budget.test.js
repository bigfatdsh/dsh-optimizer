/**
 * 花费折子：计价口径、重复计费、重试、时段价、预值判定。
 *
 * 这几条是"弹窗到底会不会弹、弹得对不对"的全部依据，所以要钉住的是**金额本身**，
 * 不是"函数被调用了"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CostLedger,
  OFFICIAL_PRICING,
  attemptNanos,
  foldCost,
  formatYuan,
  isPeakAt,
  messageRoute,
  normalizeSample,
  overBudget,
  resolvePrice,
  streamSample,
  toNanos,
  zeroSpend,
} from '../lib/budget.js'

/** 一个空的计价状态。 */
const fresh = () => ({ ...zeroSpend(), route: undefined, last: undefined })

/** 2026-01-05（周一）11:00 北京 = 03:00 UTC：高峰时段。 */
const PEAK = Date.UTC(2026, 1 - 1, 5, 3, 0, 0)
/** 2026-01-05（周一）20:00 北京 = 12:00 UTC：空闲时段。 */
const VALLEY = Date.UTC(2026, 1 - 1, 5, 12, 0, 0)

/** 一条 `assistant/message`。 */
function messageEvent({ turn = 1, step = 1, usage, model = 'deepseek-flash', time = PEAK, id = `m${turn}-${step}` } = {}) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      usage,
      message: { id, source: { kind: 'model', provider: 'deepseek-account', model } },
    },
  }
}

test('时段：工作日两个区间是高峰，周末与节假日全天是空闲', () => {
  assert.equal(isPeakAt(PEAK), true, '周一 11:00 北京是高峰')
  assert.equal(isPeakAt(VALLEY), false, '周一 20:00 北京是空闲')
  // 2026-01-04 是周日
  assert.equal(isPeakAt(Date.UTC(2026, 0, 4, 3, 0, 0)), false, '周日是空闲')
  // 2026-01-01 是元旦（节假日表里）
  assert.equal(isPeakAt(Date.UTC(2026, 0, 1, 3, 0, 0)), false, '法定节假日是空闲')
  assert.equal(isPeakAt(undefined), false, '时刻非法时按空闲算，不抛错')
})

test('价目：按子串匹配、长的键优先、认不出的模型不猜价', () => {
  assert.deepEqual(resolvePrice('deepseek-flash', false), { hit: 0.02, miss: 1, out: 4 })
  assert.deepEqual(resolvePrice('deepseek-flash', true), { hit: 0.04, miss: 2, out: 8 })
  assert.deepEqual(resolvePrice('deepseek-v4-pro', false), { hit: 0.15, miss: 4.5, out: 13.5 })
  // 带日期/后缀的真实名字仍要命中
  assert.deepEqual(resolvePrice('deepseek-v4-flash-20260101', false), { hit: 0.02, miss: 1, out: 4 })
  assert.equal(resolvePrice('some-other-model', false), undefined)
  assert.equal(resolvePrice(undefined, false), undefined)
  assert.equal(Object.keys(OFFICIAL_PRICING).length, 4, '价目表就是这四条，改名要同步改注释')
})

test('换算：纳元 = token × 单价 × 1000，缓存写入按未命中计费', () => {
  const price = resolvePrice('deepseek-flash', false)
  // 1000 未命中 + 200 缓存写（也算未命中）：1200 × 1 元/百万 = 1,200,000 纳元
  // 5000 命中：5000 × 0.02 = 100,000 纳元；500 输出：500 × 4 = 4,000,000 纳元
  assert.equal(attemptNanos({ uncachedInputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 200, outputTokens: 500 }, price), 3_300_000)
  // 最便宜的一笔：1 个命中缓存的 token（0.02 元/百万）也要能表示出来
  assert.equal(attemptNanos({ uncachedInputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0 }, price), 20)
})

test('用量归一：字段非法或为负就不算这一笔，绝不猜', () => {
  assert.deepEqual(normalizeSample({ inputTokens: 1, outputTokens: 2 }), {
    uncachedInputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 2,
  })
  assert.equal(normalizeSample({ inputTokens: -1, outputTokens: 2 }), undefined)
  assert.equal(normalizeSample({ inputTokens: 1.5, outputTokens: 2 }), undefined)
  assert.equal(normalizeSample({ inputTokens: 1 }), undefined, '缺 outputTokens 就不算')
  assert.equal(normalizeSample('nope'), undefined)
})

test('流式用量：从尾部找最后一个 usage chunk', () => {
  const stream = [
    { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } },
  ]
  assert.deepEqual(streamSample(stream), {
    uncachedInputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 3,
  })
  assert.equal(streamSample([{ type: 'chunk', chunk: { type: 'text', text: 'hi' } }]), undefined)
  assert.equal(streamSample(undefined), undefined)
})

test('路由：provider 与 model 缺一不算有路由', () => {
  assert.deepEqual(messageRoute({ source: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' })
  assert.equal(messageRoute({ source: { provider: 'p' } }), undefined)
  assert.equal(messageRoute({}), undefined)
  assert.equal(messageRoute(null), undefined)
})

test('折叠：一次请求计一次，同事件重复到达不再计', () => {
  const usage = { inputTokens: 1000, outputTokens: 500 }
  const first = foldCost(fresh(), messageEvent({ usage }))
  assert.ok(first.nanos > 0, '有路由有用量就该计费')
  assert.equal(first.unpricedTokens, 0)
  assert.deepEqual(first.route, { provider: 'deepseek-account', model: 'deepseek-flash' })

  const again = foldCost(first, messageEvent({ usage }))
  assert.equal(again, first, '同一 (turn, step) 的同一份用量：引用都不换')
})

test('折叠：attempt 与 message 是同一次请求，但真重试要各算一次', () => {
  const usage = { inputTokens: 1000, outputTokens: 500 }
  const settled = foldCost(fresh(), messageEvent({ usage }))
  const attempt = foldCost(settled, {
    type: 'assistant/attempt',
    time: PEAK,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
  })
  assert.equal(attempt, settled, '同一份用量不算第二遍')

  // 宿主说这一步要重发：清掉"已计费"标记，重发的那次要重新计
  const retried = foldCost(settled, { type: 'llm/retry-started', time: PEAK, data: { turn: 1, step: 1 } })
  assert.equal(retried.last, undefined)
  const recounted = foldCost(retried, messageEvent({ usage }))
  assert.equal(recounted.nanos, settled.nanos * 2, '重试是第二次真实请求，要累加')
})

test('折叠：认不出的模型计成未计价 token，金额不动', () => {
  const state = foldCost(fresh(), messageEvent({ usage: { inputTokens: 1000, outputTokens: 500 }, model: 'mystery-1' }))
  assert.equal(state.nanos, 0, '不猜价')
  assert.equal(state.unpricedTokens, 1500, '但要如实记下有多少 token 没算钱')
})

test('折叠：没有 usage 的事件只更新路由，不动金额', () => {
  const state = foldCost(fresh(), messageEvent({ usage: undefined }))
  assert.equal(state.nanos, 0)
  assert.deepEqual(state.route, { provider: 'deepseek-account', model: 'deepseek-flash' }, '路由仍要记住，下一次没有路由时回落到它')
})

test('折叠：turn/end 之后同一格可以重新计（跨轮的同一 step 号不算重复）', () => {
  const usage = { inputTokens: 10, outputTokens: 10 }
  const first = foldCost(fresh(), messageEvent({ usage }))
  const ended = foldCost(first, { type: 'turn/end', time: PEAK, data: { turn: 1, reason: 'completed' } })
  assert.equal(ended.last, undefined)
  const second = foldCost(ended, messageEvent({ turn: 2, step: 1, usage }))
  assert.equal(second.nanos, first.nanos * 2)
})

test('折子：按会话分别记账，淘汰最旧的，drop 掉就没了', () => {
  const ledger = new CostLedger(2)
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const usage = { inputTokens: 100, outputTokens: 100 }
  ledger.record(a, messageEvent({ usage }))
  ledger.record(b, messageEvent({ usage }))
  assert.equal(ledger.peek(a).nanos > 0, true)
  ledger.record(c, messageEvent({ usage }))
  assert.equal(ledger.records.size, 2, '上限是硬的')
  assert.equal(ledger.peek(a), undefined, '最旧的被淘汰')
  assert.equal(ledger.peek(c).nanos > 0, true)

  ledger.drop(c)
  assert.equal(ledger.peek(c), undefined)
  ledger.clear()
  assert.equal(ledger.records.size, 0)
})

test('折子：只看一眼不会建档（没花过钱的会话不该占位置）', () => {
  const ledger = new CostLedger(4)
  assert.equal(ledger.peek({ id: 'x' }), undefined)
  assert.equal(ledger.records.size, 0, 'peek 是只读的')
})

test('判定：没开开关 / 没填预值 / 还没到，都不拦', () => {
  const spend = { nanos: 5_000_000_000, unpricedTokens: 0 }
  assert.equal(overBudget(spend, 5_000_000_000, false), false, '开关关着')
  assert.equal(overBudget(spend, 0, true), false, '预值 0 = 不限')
  assert.equal(overBudget({ nanos: 4_999_999_999 }, 5_000_000_000, true), false, '还差一点')
  assert.equal(overBudget(spend, 5_000_000_000, true), true, '刚好到也拦')
  assert.equal(overBudget({ nanos: 6_000_000_000 }, 5_000_000_000, true), true)
})

test('判定：小预值也要真的生效（曾经被微元的精度吃掉）', () => {
  // 用户填 0.0001 元 = 100000 纳元；一笔典型请求约 600 万纳元，必须拦得住。
  const limit = toNanos('0.0001')
  assert.equal(limit, 100_000)
  assert.equal(overBudget({ nanos: 6_000_000 }, limit, true), true)
  // 更小的：0.0000005 元 = 500 纳元，仍要是个有效的预值（微元下会被舍成 0 或 1）
  assert.equal(toNanos('0.0000005'), 500)
  assert.equal(overBudget({ nanos: 600 }, 500, true), true)
  // 最便宜的一笔（1 个命中 token = 20 纳元）也要能被判到
  assert.equal(overBudget({ nanos: 20 }, toNanos('0.00000002'), true), true)
})

test('换算：元 → 纳元，十进制解析不给浮点留缝隙', () => {
  assert.equal(toNanos(5), 5_000_000_000)
  assert.equal(toNanos('0.01'), 10_000_000)
  assert.equal(toNanos(' 2.5 '), 2_500_000_000)
  assert.equal(toNanos(0), 0)
  assert.equal(toNanos(''), undefined, '空串是"没填"，不是 0：交给调用方决定')
  assert.equal(toNanos('0.0001'), 100_000, '这条曾经被浮点乘法算成 99999.999… 再被舍成 0')
  assert.equal(toNanos('.5'), 500_000_000)
  assert.equal(toNanos('5.'), 5_000_000_000)
  assert.equal(toNanos('0.000000001'), 1, '最小一格就是 1 纳元')
  assert.equal(toNanos('0.0000000001'), undefined, '比纳元更细的位数直接拒绝，不静默截断')
  assert.equal(toNanos(-1), undefined)
  assert.equal(toNanos('abc'), undefined)
  assert.equal(toNanos('.'), undefined)
  assert.equal(toNanos(Number.NaN), undefined)
  assert.equal(toNanos(1e9), undefined, '大到不安全整数就拒绝')
})

test('展示：纳元 → 元，去掉尾随零但不吃有效位', () => {
  assert.equal(formatYuan(0), '0.00')
  assert.equal(formatYuan(0.0001 * 1e9), '0.0001')
  assert.equal(formatYuan(5_000_000_000), '5.00')
  assert.equal(formatYuan(6_000_000), '0.006')
  assert.equal(formatYuan(20), '0.00', '小于 1e-6 元在界面上就是 0.00')
  assert.equal(formatYuan(undefined), '0.00')
})
