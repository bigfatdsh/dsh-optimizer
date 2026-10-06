/**
 * 花费预警：把「本会话花了多少钱」折成一个整数，并在越过预值时给出判定。
 *
 * ## 为什么自己算钱，而不是去读别的插件
 *
 * 计价的判据必须和界面上的数字**同源同单位**。会话投影只能在会话事件上折叠，
 * 别的插件的投影键既不保证装了、也不保证版本一致；预警一旦依赖它，缺一个插件
 * 就整条功能失效。所以这里自带一份官方价目表（与 `dsh-session-cost` 逐条一致），
 * 只折叠**与计费有关**的三种事件，其余事件原样返回，不算、不分配。
 *
 * ## 口径：一次模型请求 = 一次计费
 *
 * `assistant/message` 与 `assistant/attempt` 各自代表一次真实请求，都会产生费用，
 * 因此是**累加**关系。`llm/retry-started` 表示同一步要重发，所以先把上一次的
 * 「已计费标记」清掉，重试才会重新计一次——这条与官方 token 计量的口径一致：
 * 漏算一次成功请求，比在异常序列上多算一次更糟，但同一次请求**绝不能算两遍**。
 *
 * ## 单位：微元
 *
 * 价格是「元 / 百万 token」，所以 `微元 = token × 单价`（整数，无浮点漂移）。
 * 预值也一律换算成微元再比较，界面上只做展示时除以 1e6。
 *
 * @module dsh-optimizer/budget
 */

/**
 * 内置价目表，单位「元 / 百万 token」。
 *
 * 每个模型三个桶，每个桶是 `[空闲时段价, 高峰时段价]`：
 * - `hit`  —— 输入，缓存命中
 * - `miss` —— 输入，缓存未命中（缓存写入同样按未命中计费）
 * - `out`  —— 输出
 *
 * 键按「长度降序」做子串匹配（见 {@link resolvePrice}），所以 `deepseek-v4-pro`
 * 不会被 `deepseek-v4` 之类的前缀误伤。
 */
export const OFFICIAL_PRICING = Object.freeze({
  // deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 两个旧名已下线，
  // 请求由 V4.1-Flash 提供服务并按 Flash 价计费，故三者同价。
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
})

/**
 * 2026 年中国法定节假日（只列**放假**日期；调休上班日都落在周末，本来就按空闲计费）。
 *
 * 官方脚注：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00 为高峰，
 * 其余时段（含周末与法定节假日全天）为空闲。2026 年安排公布后照此表核对；
 * 缺一年只会让那一年按「工作日/周末」近似——**不会算错方向**，因为高峰时段
 * 只在工作日出现，节假日多算成高峰只影响金额大小，不会影响"是否越过预值"的
 * 判定方向以外的东西。要精确可换 `VALLEY_HOLIDAYS` 自行维护。
 */
export const VALLEY_HOLIDAYS = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
])

/** 一次性构造节假日查找集合。 */
const HOLIDAYS = new Set(VALLEY_HOLIDAYS)

/** 高峰时段（北京时间的小时区间，左闭右开）。 */
const PEAK_HOURS = Object.freeze([[9, 12], [14, 18]])

/** 北京时间的偏移毫秒数（中国全境单一时区，无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 同时在记的会话上限：超出的按插入顺序淘汰最旧的。 */
export const SESSION_LIMIT = 64

/** 一次模型请求归零后的空花费。 */
export function zeroSpend() {
  return { nanos: 0, unpricedTokens: 0, started: 0 }
}

/**
 * 判定一个时刻是否处于**高峰时段**。
 *
 * @param {unknown} epochMs - 事件时刻（毫秒）。
 * @returns {boolean} 高峰返回 true（价目取第二位），否则取第一位。
 */
export function isPeakAt(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return false
  const beijing = new Date(epochMs + BEIJING_OFFSET_MS)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAYS.has(beijing.toISOString().slice(0, 10))) return false
  const hour = beijing.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/**
 * 为一个模型名解析单价。
 *
 * 匹配方式是**大小写不敏感的子串**，键按长度降序取第一个命中：模型名里常带
 * 日期、供应商前缀或 `-exp` 后缀，精确相等会漏掉它们。
 *
 * @param {unknown} model - 路由到的模型名。
 * @param {boolean} peak - 是否高峰时段。
 * @returns {{hit: number, miss: number, out: number}|undefined} 单价；认不出返回 undefined。
 */
export function resolvePrice(model, peak) {
  const name = typeof model === 'string' ? model.toLowerCase() : ''
  if (name === '') return undefined
  const keys = Object.keys(OFFICIAL_PRICING).sort((left, right) => right.length - left.length)
  for (const key of keys) {
    if (!name.includes(key)) continue
    const buckets = OFFICIAL_PRICING[key]
    return { hit: buckets.hit[peak ? 1 : 0], miss: buckets.miss[peak ? 1 : 0], out: buckets.out[peak ? 1 : 0] }
  }
  return undefined
}

/**
 * 把一次请求的用量换算成**纳元**（1 纳元 = 1e-9 元）。
 *
 * 缓存写入按**未命中**计费（官方口径），所以 miss 桶要加上 cacheWrite。
 *
 * 为什么是纳元而不是微元：预值是用户随手填的元。填 `0.000001` 元时微元的精度
 * 就不够了（1 微元 = 0.000001 元），而 DeepSeek 最便宜的一笔也要 0.00002 元
 * （1 个命中缓存的 token），"1 微元"这种量级根本落不到账上——预值判定的下限
 * 必须比**最小可能花费**还小一档。纳元给到 1e-9 元，比最小花费小四个数量级。
 *
 * @param {{uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}} buckets - 四个互不重叠的桶。
 * @param {{hit: number, miss: number, out: number}} price - 单价（元 / 百万 token）。
 * @returns {number} 进位到整数的纳元。
 */
export function attemptNanos(buckets, price) {
  // 价目是"元 / 百万 token"，乘 1000 就是"纳元 / token"：整数乘整数，不经过浮点。
  const missTokens = buckets.uncachedInputTokens + buckets.cacheWriteTokens
  return Math.round(
    (missTokens * price.miss + buckets.cacheReadTokens * price.hit + buckets.outputTokens * price.out) * 1000,
  )
}

/** 一个 token 桶必须是非负安全整数。 */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 把 provider 报的 usage 归一化成四个互不重叠的桶。
 *
 * `inputTokens` 已经是**未命中**输入，所以这里不做任何相减；缺失的缓存字段按 0。
 *
 * @param {unknown} usage - 事件上的 usage。
 * @returns {{uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number}|undefined} 桶；非法返回 undefined。
 */
export function normalizeSample(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const source = /** @type {Record<string, unknown>} */ (usage)
  const uncached = count(source.inputTokens)
  const output = count(source.outputTokens)
  if (uncached === undefined || output === undefined) return undefined
  const cacheRead = count(source.cacheReadTokens ?? 0)
  const cacheWrite = count(source.cacheWriteTokens ?? 0)
  if (cacheRead === undefined || cacheWrite === undefined) return undefined
  const total = uncached + cacheRead + cacheWrite + output
  if (!Number.isSafeInteger(total)) return undefined
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
  }
}

/**
 * 读一条 durable assistant stream 里最后一个 usage chunk。
 *
 * `@deepseek-ai/dsh-llm` 的 `lastAssistantStreamChunk` 做的是同一件事，但那个包
 * 在 profile 侧不一定解析得到（见模块头注释），所以这里复刻它的形状：
 * 从尾部找 `{ type: 'chunk', chunk: { type: 'usage' } }`。
 *
 * @param {unknown} stream - 事件的 `data.stream`。
 * @returns {object|undefined} 四个桶；没有或非法返回 undefined。
 */
export function streamSample(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (typeof record !== 'object' || record === null) continue
    const typed = /** @type {{type?: string, chunk?: {type?: string, usage?: unknown}}} */ (record)
    if (typed.type !== 'chunk') continue
    const chunk = typed.chunk
    if (typeof chunk !== 'object' || chunk === null || chunk.type !== 'usage') continue
    return normalizeSample(chunk.usage)
  }
  return undefined
}

/**
 * 从一条 assistant 消息里读它的路由。
 *
 * @param {unknown} message - `event.data.message`。
 * @returns {{provider: string, model: string}|undefined} 路由；缺一返回 undefined。
 */
export function messageRoute(message) {
  if (typeof message !== 'object' || message === null) return undefined
  const source = /** @type {{source?: {provider?: unknown, model?: unknown}}} */ (message).source
  if (typeof source !== 'object' || source === null) return undefined
  const provider = typeof source.provider === 'string' ? source.provider : ''
  const model = typeof source.model === 'string' ? source.model : ''
  return provider === '' || model === '' ? undefined : { provider, model }
}

/**
 * 一个会话的计价状态：累计花费、未计价 token、已知路由、以及"这一格是否已计费"。
 *
 * `last` 只在**同一次尝试**里用来防重复：同 `(turn, step)` 的 message 与 attempt
 * 是同一次请求的两种落地形态，只能算一次；`llm/retry-started` 一到就作废这个标记。
 *
 * @param {object} state - 上一个状态。
 * @returns {object} 下一个状态。
 */
function settle(state) {
  return { ...state, last: undefined }
}

/**
 * 两份用量桶是否逐字段相等。
 *
 * 同 `(turn, step)` 的 attempt 与 message 是同一次请求的两种落地形态：用量完全相同
 * 时只算一次；不同（真实重试但没发 `llm/retry-started`）时按新请求累加。
 *
 * @param {object|undefined} left - 上一份桶。
 * @param {object} right - 这一份桶。
 * @returns {boolean} 是否相等。
 */
function sameBuckets(left, right) {
  return left !== undefined
    && left.uncachedInputTokens === right.uncachedInputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.outputTokens === right.outputTokens
}

/**
 * 每个会话一条花费记录。
 *
 * 用会话对象本身当键（与 `Ledger` 同口径）；超过上限淘汰最旧的一条，
 * 会话销毁时由宿主侧显式 `drop`。
 */
export class CostLedger {
  /**
   * @param {number} [limit] - 同时记的会话上限。
   */
  constructor(limit = SESSION_LIMIT) {
    /** @type {Map<unknown, Record<string, any>>} */
    this.records = new Map()
    this.limit = limit
  }

  /**
   * 记一次会话事件，返回**新**的花费状态（无变化时返回同一个引用）。
   *
   * @param {unknown} session - 会话标识。
   * @param {Record<string, unknown>} event - 一条 committed `SessionEvent`。
   * @returns {Record<string, unknown>} 该会话最新的花费状态。
   */
  record(session, event) {
    const current = this.peek(session) ?? { nanos: 0, unpricedTokens: 0, started: 0, route: undefined, last: undefined }
    const next = foldCost(current, event)
    if (next === current) return current
    this.records.set(session, next)
    // 只在新键上淘汰：Map 保持插入顺序，删最早的一个。
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) break
      this.records.delete(oldest.value)
    }
    return next
  }

  /**
   * 看一眼某会话的花费状态，**不创建**记录。
   *
   * 「看一眼」必须没有副作用：注册过的会话投影会对每个会话调用它，一旦这里顺手
   * 建档，从没花过钱的会话也会占满上限、把真正要拦的会话挤掉。
   *
   * @param {unknown} session - 会话标识。
   * @returns {Record<string, unknown>|undefined} 该会话的花费状态；没记过返回 undefined。
   */
  peek(session) {
    return this.records.get(session)
  }

  /** @param {unknown} session - 会话标识。 */
  drop(session) {
    this.records.delete(session)
  }

  /** 清空所有会话（测试用）。 */
  clear() {
    this.records.clear()
  }
}

/**
 * 纯折叠：一条会话事件 → 下一个花费状态。
 *
 * 只认三种事件，其余一律原样返回（**同一个引用**）：不产生分配，也就不会让
 * 会话投影误判"变了"。
 *
 * @param {Record<string, any>} state - 上一个状态。
 * @param {Record<string, any>} event - 一条 `SessionEvent`。
 * @returns {Record<string, any>} 下一个状态；无变化时同一个引用。
 */
export function foldCost(state, event) {
  const type = event?.type
  if (type === 'llm/retry-started') {
    const data = event.data ?? {}
    const last = state.last
    if (last === undefined || last.turn !== data.turn || last.step !== data.step) return state
    return settle(state)
  }
  if (type === 'turn/end' || type === 'session/closed') {
    return state.last === undefined ? state : settle(state)
  }
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return state

  const data = event.data ?? {}
  const turn = typeof data.turn === 'number' ? data.turn : -1
  const step = typeof data.step === 'number' ? data.step : -1
  const message = data.message
  const route = type === 'assistant/message' ? (messageRoute(message) ?? state.route) : state.route
  const sample = normalizeSample(data.usage) ?? streamSample(data.stream)
  const base = {
    ...state,
    route,
    started: state.started === 0 && typeof event.time === 'number' ? event.time : state.started,
  }
  // 没有用量样本（例如流被中断、供应商没报 usage）：只更新路由，不动金额。
  if (sample === undefined) return route === state.route ? state : base

  // 同一格、同一份用量：attempt 与 message 描述的是同一次请求，只算一次。
  const last = state.last
  const settled = last !== undefined && last.turn === turn && last.step === step
  if (settled && sameBuckets(last.buckets, sample)) return state

  const total = sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens + sample.outputTokens
  const price = resolvePrice(route?.model, isPeakAt(typeof event.time === 'number' ? event.time : Date.now()))
  const nanos = price === undefined ? 0 : attemptNanos(sample, price)
  return {
    ...base,
    nanos: base.nanos + nanos,
    unpricedTokens: base.unpricedTokens + (price === undefined ? total : 0),
    last: { turn, step, buckets: sample },
  }
}

/**
 * 判定一个会话当前的花费是否越过预值。
 *
 * 三个"不拦"的理由都是**故意的**：没开开关、没填预值、花费还没到——任何一条
 * 成立都返回 false，让宿主完全不动这个会话。
 *
 * @param {Record<string, any>} spend - 花费状态。
 * @param {number} limitNanos - 预值（纳元）；0 或负数表示没设。
 * @param {boolean} enabled - 花费预警开关。
 * @returns {boolean} 是否应当阻断。
 */
export function overBudget(spend, limitNanos, enabled) {
  if (enabled !== true) return false
  if (!Number.isSafeInteger(limitNanos) || limitNanos <= 0) return false
  return spend.nanos >= limitNanos
}

/**
 * 把「元」文本解析成**纳元**。
 *
 * 走**十进制字符串**而不是浮点乘法：`0.0001 * 1e9` 这类算式在 IEEE754 下会给出
 * 99999.999…，`Math.round` 之后再遇到小数截断就可能变成 0——用户明明填了预值，
 * 却被判成"没设"。逐位解析没有这个问题。
 *
 * 接受 `5`、`0.0001`、`.5`、`5.`；拒绝负数、非数字、超过 9 位小数（纳元是原子
 * 单位，更细的位数没有意义）与超出安全整数的值。
 *
 * @param {unknown} value - 界面或配置来的原始值。
 * @returns {number|undefined} 纳元（非负安全整数）；非法返回 undefined。
 */
export function toNanos(value) {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  if (text === '') return undefined
  if (!/^\d*\.?\d*$/.test(text) || text === '.') return undefined
  const [whole = '', fraction = ''] = text.split('.')
  if (fraction.length > 9) return undefined
  const digits = `${whole === '' ? '0' : whole}${fraction.padEnd(9, '0')}`
  const nanos = Number(digits)
  return Number.isSafeInteger(nanos) ? nanos : undefined
}

/**
 * 纳元 → 元（展示用）。
 *
 * 最多 6 位小数、去掉尾随零、至少保留 2 位：`0.006` 显示成 `0.006`，`0.0001`
 * 显示成 `0.0001`，`5` 显示成 `5.00`。比这更小的金额（< 1e-6 元）在界面上就是
 * `0`——那种量级只用于内部比较，展示出来没有意义。
 *
 * @param {unknown} nanos - 纳元。
 * @returns {string} 元的文本表示。
 */
export function formatYuan(nanos) {
  const value = typeof nanos === 'number' && Number.isFinite(nanos) ? nanos : 0
  const fixed = (value / 1_000_000_000).toFixed(6)
  const trimmed = fixed.replace(/(\.\d{2}\d*?)0+$/, '$1').replace(/\.$/, '.00')
  return trimmed.includes('.') ? trimmed : `${trimmed}.00`
}
