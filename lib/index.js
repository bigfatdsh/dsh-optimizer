/**
 * dsh-optimizer —— 优化插件集（宿主半边）。
 *
 * ## 三个开关
 *
 * 1. **推理等级 auto**：每个 turn 的起点判一次"这活儿有多重"，把结果落成该模型**真实
 *    支持**的推理档位。轻活少想，重活多想；判不出来就用模型默认。挂的是两个宿主公开
 *    的契约事件（`agent/pre-step` 判组、`agent/request` 落地），**不包任何模型调用
 *    路径、不改模型目录、不碰模型选择器**。
 * 2. **精简化输出**：在系统提示词**最后**追加一段输出纪律，要求模型把回复里"任务内容
 *    之外"的部分压到最少：零开场白、零复述、零装饰性小节。提示词段落是"生成前约束"，
 *    不是"生成后裁剪"，所以交付物的内容与质量与不装插件时一致。
 * 3. **花费预警**：本会话花费到预值（元）就**停住这一轮**，弹窗要用户先验证六位数字才
 *    放行；选"终止任务"就是停手，并把本会话**最初的提示词**摆回弹窗给用户看——
 *    **不下发任何删除/清理指令**。判定在 `session/event` 上做（花费只在那里变），
 *    `agent/pre-step` 只做兜底；停下走的是宿主自己的 `agent.cancel()`，放行走
 *    `agent.followup()`，**推理等级一个字都不动**。
 *
 * ## 谁说了算（推理等级）
 *
 * 1. 用户在模型选择器里手选的档位 → 永远优先，插件立刻停手；
 * 2. `config.force` / `config.levels` 指定的档位；
 * 3. 每轮判定结果；
 * 4. 都不适用 → 原样透传，宿主自己决定。
 *
 * ## 失败方向
 *
 * 判不出、目录查不到、模型不支持、任何异常：一律**原样透传**。插件出错只有一个后果——
 * 这次请求用模型默认档位，而不是请求失败。注册类动作（段落、端点、监听、投影）全部经过
 * `guard()`：其中任何一项失败只丢掉它自己，不影响其它功能。花费预警同理：钱算不出来
 * （认不出的模型）就只记"未计价 token"，绝不猜一个价去拦用户的任务。
 *
 * ## 装配永不失败
 *
 * 读不出状态、写不进盘、注册被拒，都退回"能跑的那部分照常跑"。
 *
 * @module dsh-optimizer
 */

import { randomUUID } from 'node:crypto'

import { classifyMessage } from './classify.js'
import { resolveEffort } from './efforts.js'
import { ConciseState, ToggleState, readStore, resolveDshHome, statePath } from './state.js'
import { resolveDirective } from './directive.js'
import { Config, resolveConfig } from './schema.js'
import { CostLedger, overBudget, toNanos } from './budget.js'

/** 插件名。 */
export const name = 'optimizer'

export { Config }

/** 需要的服务：提示词段落面 + 浏览器开关的通路。`llm` 可选，不用它换更少的依赖。 */
export const inject = ['systemPrompt', 'webServer']

/** 浏览器开关的端点路径。 */
export const ROUTE_PATH = '/dsh-optimizer'

/** 段落在系统提示词里的名字。**必须唯一**：与别的插件撞名会被宿主拒绝注册。 */
export const SECTION_NAME = 'optimizer:concise'

/** 段落顺序：恒定在最后，不动前面任何一段的前缀缓存。 */
export const SECTION_ORDER = 10200

/** 档位元数据的缓存时长：成功 5 分钟，失败 1 分钟。 */
const CACHE_OK_MS = 300_000
const CACHE_FAIL_MS = 60_000

/** 同时在记的会话上限。 */
const LEDGER_LIMIT = 64

/** 诊断里保留的最近判定条数。 */
const RECENT_LIMIT = 20

/** 花费预警投影的键。与别的插件撞名会被宿主拒绝注册，所以带插件前缀。 */
export const GUARD_PROJECTION_KEY = 'optimizerCostGuard'

/** 状态文件里花费预警开关的字段名。 */
export const GUARD_FIELD = 'costGuard'

/** 一次会话里保留的原始提示词上限（字符）：弹窗只展示，不参与判定。 */
const PROMPT_LIMIT = 4000

/**
 * 一次装配的计数器。**只存数字**，不持有任何对象。
 */
export class AssembleStats {
  constructor() {
    /** @type {number} */
    this.assembled = 0
    /** @type {number} */
    this.injected = 0
  }

  /**
   * @param {boolean} enabled - 这次是否注入了指令。
   */
  record(enabled) {
    this.assembled += 1
    if (enabled) this.injected += 1
  }

  /** @returns {{assembled: number, injected: number}} 快照。 */
  snapshot() {
    return { assembled: this.assembled, injected: this.injected }
  }
}

/**
 * 花费预警的计数器。
 *
 * 只记「拦了几次、唤醒了几次、下指令失败几次」这类**事实**，不记金额、不记会话，
 * 所以诊断端点可以随便暴露它。
 */
export class CostStats {
  constructor() {
    /** @type {number} */
    this.blocked = 0
    /** @type {number} */
    this.woken = 0
    /** @type {number} */
    this.failed = 0
  }

  /** @returns {{blocked: number, woken: number, failed: number}} 快照。 */
  snapshot() {
    return { blocked: this.blocked, woken: this.woken, failed: this.failed }
  }
}

/**
 * 推理等级的计数器与诊断流水。**只存数字与档位名**，不存消息、不存会话对象。
 */
export class EffortStats {
  constructor() {
    /** @type {number} */
    this.turns = 0
    /** @type {number} */
    this.applied = 0
    /** @type {number} */
    this.skipped = 0
    /** @type {number} */
    this.failed = 0
    /** @type {Record<string, number>} */
    this.buckets = { quiet: 0, light: 0, standard: 0, heavy: 0 }
    /** @type {Array<Record<string, unknown>>} */
    this.recent = []
  }

  /**
   * 记一次判定。
   *
   * @param {string} bucket - 判出的组。
   * @param {boolean} inherited - 是否靠继承得出。
   */
  recordTurn(bucket, inherited) {
    this.turns += 1
    if (this.buckets[bucket] !== undefined) this.buckets[bucket] += 1
    this.push({ kind: 'judge', bucket, inherited: inherited === true })
  }

  /**
   * 记一次落地。
   *
   * @param {Record<string, unknown>} entry - 一条精简记录。
   */
  push(entry) {
    this.recent.push(entry)
    while (this.recent.length > RECENT_LIMIT) this.recent.shift()
  }

  /** @returns {object} 快照。 */
  snapshot() {
    return {
      turns: this.turns,
      applied: this.applied,
      skipped: this.skipped,
      failed: this.failed,
      buckets: { ...this.buckets },
      recent: this.recent.map((entry) => ({ ...entry })),
    }
  }
}

/**
 * 每个会话一条记录：上一次判出什么组、插件上次写了什么档位、用户是否手选过。
 *
 * 用会话对象本身当键；会话销毁即释放。
 */
export class Ledger {
  constructor(limit = LEDGER_LIMIT) {
    /** @type {Map<unknown, Record<string, unknown>>} */
    this.records = new Map()
    this.limit = limit
  }

  /**
   * @param {unknown} session - 会话标识。
   * @returns {Record<string, unknown>} 该会话的记录。
   */
  of(session) {
    const existing = this.records.get(session)
    if (existing !== undefined) return existing
    const record = { bucket: undefined, applied: undefined, manual: false, turn: undefined, step: undefined }
    this.records.set(session, record)
    // 只在新键上淘汰：Map 保持插入顺序，删最早的一个。
    while (this.records.size > this.limit) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) break
      this.records.delete(oldest.value)
    }
    return record
  }

  /**
   * @param {unknown} session - 会话标识。
   */
  drop(session) {
    this.records.delete(session)
  }

  /** 用户重新打开 auto：忘掉"他手选过"。 */
  unlock() {
    for (const record of this.records.values()) record.manual = false
  }
}

/**
 * 解析用户消息里的纯文本。
 *
 * @param {unknown} message - 一条用户消息。
 * @returns {string} 文本；取不到就是空串。
 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const source = /** @type {{source?: {kind?: string}}} */ (message).source
  if (source !== undefined && source.kind !== undefined && source.kind !== 'user') return ''
  const content = /** @type {{content?: unknown}} */ (message).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = /** @type {{type?: string, text?: unknown}} */ (block)
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n')
}

/**
 * 写一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {object} payload - 响应体。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读一个小 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<object|undefined>} 解析结果；坏 JSON 或非对象返回 undefined。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 装配插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - 插件配置。
 * @returns {object} 控制句柄（测试用；宿主忽略）。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /**
   * 解析一个宿主服务。
   *
   * **必须在每次使用时重新解析**，不能只捕获装配那一刻的值：`inject` 只保证依赖在图里，
   * 不保证 `apply` 执行时提供者已经就位（实测踩过：捕获到 undefined 后每次请求都抛错）。
   *
   * @param {string} key - 服务名。
   * @returns {object|undefined} 服务对象。
   */
  const service = (key) => {
    const fromGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
    if (fromGet !== undefined) return fromGet
    return ctx[key]
  }

  const state = new ConciseState({
    initial: config.conciseDefault === true,
    file: config.persist
      ? (typeof config.file === 'string' && config.file !== '' ? config.file : statePath(resolveDshHome()))
      : undefined,
    onError: (error) => ctx?.logger?.warn?.(`optimizer: state write failed: ${error?.message ?? error}`),
  })

  const autoState = new ToggleState({
    field: 'auto',
    initial: config.autoDefault === true,
    file: config.persist
      ? (typeof config.file === 'string' && config.file !== '' ? config.file : statePath(resolveDshHome()))
      : undefined,
    onError: (error) => ctx?.logger?.warn?.(`optimizer: auto state write failed: ${error?.message ?? error}`),
  })

  /** 花费预警开关（默认关闭）。 */
  const guardState = new ToggleState({
    field: GUARD_FIELD,
    initial: config.costGuardDefault === true,
    file: config.persist
      ? (typeof config.file === 'string' && config.file !== '' ? config.file : statePath(resolveDshHome()))
      : undefined,
    onError: (error) => ctx?.logger?.warn?.(`optimizer: cost guard state write failed: ${error?.message ?? error}`),
  })

  /** 花费预值（微元）。界面里填的是元，换算后才落到这里。 */
  /**
   * 每个会话各自的预值（纳元），挂在拦截记录上。
   *
   * **不落盘、不共享**：预值是"这一场会话打算花多少"，A 会话设 0.0001 不该让 B 会话
   * 也被拦。记录随会话销毁一起释放（会话关掉，预算也就不用留着了）。宿主重启后
   * 归零，用户在面板里重新填一次即可——这个取舍是故意的：把每个会话的限额外加一个
   * 持久化文件，收益很小，出错的姿势（读到别的会话的额度）却很难查。
   *
   * `config.costLimitDefault` 仍然是"新会话的起始预值"，填了就当所有会话的初值。
   */
  const defaultLimit = toNanos(config.costLimitDefault) ?? 0

  const stats = new AssembleStats()
  const effortStats = new EffortStats()
  const costStats = new CostStats()
  const ledger = new Ledger()
  const costLedger = new CostLedger()
  /**
   * 每个会话的「拦截状态」、原始提示词与**这个会话自己的预值**。
   *
   * **按会话 id 记，不按会话对象记**：实测踩过——同一次会话在不同回调里拿到的是
   * *不同的 Session 实例*（同一串 id，对象身份不同）。早先按对象当键，预值写在
   * A 实例上、判定时从 B 实例上读，读到的是"没设"，表现就是"填了预值却永远不拦"。
   * id 是稳定的、也是端点与界面唯一能互相指认的东西，所以一切都以 id 为准。
   *
   * @type {Map<string, {guard: string, hits: number, at: number, cancelled: boolean, prompt: string, limit: number}>}
   */
  const guards = new Map()
  /** @type {Map<string, {at: number, hit: boolean, reasoning: unknown}>} */
  const catalog = new Map()

  const warn = (message) => ctx?.logger?.warn?.(`optimizer: ${message}`)

  /**
   * 跑一段可能失败的装配，失败只降级、不牵连整个插件。
   *
   * 实测教训：宿主对"同名提示词段落"是**抛错**而不是忽略，而这个抛错发生在
   * `ctx.effect` 里——一次重名就足以让整个插件激活失败，连推理等级一起陪葬。
   * 所以注册类动作一律经过这里：失败只丢掉它自己，插件其余部分照常工作。
   *
   * @param {string} what - 出错时的日志前缀。
   * @param {() => unknown} run - 装配动作。
   * @returns {unknown} 动作返回值。
   */
  const guard = (what, run) => {
    try {
      return run()
    } catch (error) {
      warn(`${what} unavailable: ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * 该模型的推理档位（带缓存）。
   *
   * **必须用 `resolveModelInfo`，不能用 `listModels`**：实测踩过——`listModels` 返回的是
   * 目录投影（只有 provider/id/name/description/inputModalities），**故意不含** `reasoning`；
   * 拿它去查档位永远查不到，结果是"判定一直在跑、档位永远不改"。`resolveModelInfo` 才是
   * 那个会返回 "exact model identity plus available context and reasoning metadata" 的接口。
   *
   * @param {unknown} provider - 供应方。
   * @param {unknown} model - 模型 id。
   * @returns {Promise<unknown>} `reasoning` 元数据；查不到是 `undefined`。
   */
  const reasoningFor = async (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    const key = `${provider}\u0000${model}`
    const now = Date.now()
    const cached = catalog.get(key)
    if (cached !== undefined && now - cached.at < (cached.hit ? CACHE_OK_MS : CACHE_FAIL_MS)) return cached.reasoning

    const llm = service('llm')
    const resolve = llm === undefined ? undefined : llm.resolveModelInfo
    if (typeof resolve !== 'function') return undefined

    let info
    try {
      info = await resolve.call(llm, provider, model)
    } catch (error) {
      warn(`model metadata unavailable for "${provider}/${model}": ${error?.message ?? error}`)
      catalog.set(key, { at: now, hit: false, reasoning: undefined })
      return undefined
    }
    const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined
    while (catalog.size >= 64) {
      const oldest = catalog.keys().next()
      if (oldest.done === true) break
      catalog.delete(oldest.value)
    }
    catalog.set(key, { at: now, hit: true, reasoning })
    return reasoning
  }

  /**
   * 诊断用：看一眼 `llm` 服务到底能不能用、目录里有多少模型。
   *
   * 只在 skip 记录里出现，正常路径不调用。
   *
   * @returns {object} 精简探针结果。
   */
  const probeLlm = () => {
    const llm = service('llm')
    if (llm === undefined) return { service: false }
    return {
      service: true,
      resolveModelInfo: typeof llm.resolveModelInfo === 'function',
      listModels: typeof llm.listModels === 'function',
    }
  }

  /**
   * 用户是不是刚刚在界面上明确选过模型/档位。
   *
   * 宿主把它记在会话投影里，一次请求后自动清空；拿不到这个服务就当"没选过"。
   *
   * @param {unknown} session - 会话。
   * @returns {boolean} 是否处于"用户刚选过"的状态。
   */
  const pendingSelection = (session) => {
    try {
      const projections = service('sessionProjections')
      if (projections === undefined || typeof projections.stateOf !== 'function') return false
      const projected = projections.stateOf(session, 'modelSelection')
      return projected !== undefined && projected !== null && projected.pending !== null && projected.pending !== undefined
    } catch {
      return false
    }
  }

  // --- 花费预警：折叠花费、判定越界、拦截与放行 ----------------------------------
  /**
   * 取一个会话的拦截状态，**顺手建**。
   *
   * 只有真的发生在会话上的事（判题、拦下、用户答复）才会走到这里；会话投影那条
   * 只读路径用的是 {@link guardPeek}，所以从没花过钱的会话不会占位置。
   *
   * @param {unknown} session - 会话。
   * @returns {{guard: string, hits: number, at: number, cancelled: boolean, prompt: string}} 该会话的记录。
   */
  const guardOf = (session) => {
    const key = sessionKey(session)
    if (key === undefined) {
      // 认不出会话就返回一条**临时**记录：调用方拿到的是可用对象，但什么都不记住。
      return { guard: 'clear', hits: 0, at: 0, cancelled: false, prompt: '', limit: defaultLimit }
    }
    let record = guards.get(key)
    if (record !== undefined) return record
    record = { guard: 'clear', hits: 0, at: 0, cancelled: false, prompt: '', limit: defaultLimit }
    guards.set(key, record)
    // 只在新键上淘汰：Map 保持插入顺序，删最早的一个。
    while (guards.size > LEDGER_LIMIT) {
      const oldest = guards.keys().next()
      if (oldest.done === true) break
      guards.delete(oldest.value)
    }
    return record
  }

  /** @param {unknown} session - 会话。 @returns {object|undefined} 记录；没建过返回 undefined。 */
  const guardPeek = (session) => {
    const key = sessionKey(session)
    return key === undefined ? undefined : guards.get(key)
  }

  /**
   * 记下本会话**最初**的提示词。
   *
   * 拦截弹窗要在"终止任务"那一屏把最初的提示词原样给用户看，所以只认第一次：
   * 后面每一轮的用户消息都不覆盖它。取不到就不记，弹窗退化成只显示"（读不到）"。
   *
   * @param {unknown} session - 会话。
   * @param {unknown[]} messages - 本次 step 携带的用户消息。
   */
  const rememberPrompt = (session, messages) => {
    const record = guardOf(session)
    if (record.prompt !== '') return
    if (!Array.isArray(messages)) return
    for (const message of messages) {
      const text = messageText(message).trim()
      if (text === '') continue
      record.prompt = text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT)}…` : text
      return
    }
  }

  /**
   * 状态文件里是否还留着旧单位（微元）的预值键。
   *
   * 老版本把预值记在 `costLimit` 上、单位是微元；新版本记在 `costLimitNanos` 上。
   * 两个键同时存在时，说明用户升级前填过预值，需要在面板里**重新填一次**——否则
   * 他会以为预值还在，实际判定用的已经是 0（不限）。
   *
   * @returns {boolean} 是否需要提醒重新填预值。
   */
  const staleLimitKey = () => {
    if (!config.persist) return false
    const file = typeof config.file === 'string' && config.file !== '' ? config.file : statePath(resolveDshHome())
    return readStore(file, () => {})['costLimit'] !== undefined
  }

  /**
   * 某会话的预值（纳元）；0 表示没设。
   *
   * 只读、不建档：面板每次打开都会问一遍，问一次就建一条记录会把 64 条的额度白占掉。
   *
   * @param {unknown} session - 会话。
   * @returns {number} 预值（纳元）。
   */
  const limitNanos = (session) => guardPeek(session)?.limit ?? defaultLimit

  /**
   * 某会话的预值（元）。
   *
   * @param {unknown} session - 会话。
   * @returns {number} 预值（元）。
   */
  const limitYuan = (session) => limitNanos(session) / 1_000_000_000

  /**
   * 给会话投影用的只读视图。
   *
   * 拦截与否**不靠**这里算：判定只发生在真实事件路径上（{@link enforce}），
   * 投影只负责把已经发生的事实同步到浏览器。所以这个函数对没记录过的会话
   * 也不会创建任何东西。
   *
   * @param {unknown} session - 会话。
   * @returns {object} 投影视图。
   */
  const guardView = (session) => {
    // 折子的键与会话记录的键都是**会话 id**：同 id 不同实例也认得出是同一场会话。
    const key = sessionKey(session)
    const spend = key === undefined ? undefined : costLedger.peek(key)
    const record = guardPeek(session)
    return {
      enabled: guardState.get(),
      nanos: spend === undefined ? 0 : spend.nanos,
      unpricedTokens: spend === undefined ? 0 : spend.unpricedTokens,
      limit: limitYuan(session),
      guard: record === undefined ? 'clear' : record.guard,
      hits: record === undefined ? 0 : record.hits,
    }
  }

  /**
   * 会话投影的 wire 视图。
   *
   * `nanos` / `limit` 下发的是**纳元**（整数），界面自己换算成元显示；
   * 全程整数比较，避免浮点在"刚好到预值"这一格上判错方向。
   *
   * @param {object} view - {@link guardView} 的结果。
   * @returns {object} 可下发的视图。
   */
  const guardWire = (view) => ({
    enabled: view.enabled,
    nanos: view.nanos,
    unpricedTokens: view.unpricedTokens,
    limit: Math.round(view.limit * 1_000_000_000),
    guard: view.guard,
    hits: view.hits,
  })

  /**
   * 拦截判定：花费越过预值就把这一轮停住。
   *
   * 触发点是**花费真的变了**的那一刻（也就是一次模型请求结算之后），所以判定用的
   * 数字和界面上看到的是同一个。已经拦下的会话不重复拦（否则每个事件都会再喊一次
   * 取消）；用户改大预值会让它自己松开，不需要额外的"取消拦截"接口。
   *
   * @param {unknown} session - 会话。
   */
  const enforce = (session) => {
    const key = sessionKey(session)
    if (key === undefined) return
    const spend = costLedger.peek(key)
    if (spend === undefined) return
    const record = guardOf(session)
    if (record.cancelled) return
    const over = overBudget(spend, limitNanos(session), guardState.get())
    if (!over) {
      if (record.guard === 'tripped') record.guard = 'clear'
      return
    }
    if (record.guard === 'tripped') return
    record.guard = 'tripped'
    record.hits += 1
    record.at = Date.now()
    costStats.blocked += 1
    const agent = agents?.get?.(key)
    if (agent === undefined) {
      warn('cost guard tripped for a session with no live agent; the next step will be blocked')
      return
    }
    // 和用户自己按停止键同一条路，只是 cause 标成 hook：宿主据此知道这不是用户按的。
    // 不带 `keepInbox`——队列里排着的活儿也一起停下，否则"阻断"会被队列立刻续上。
    if (agent.status !== 'running') return
    try {
      agent.cancel({ kind: 'hook', reason: 'optimizer:cost-guard' })
      if (config.log) warn(`cost guard tripped at ${spend.nanos} nanos; turn cancelled`)
    } catch (error) {
      warn(`cost guard cancel failed: ${error?.message ?? error}`)
    }
  }

  /**
   * 把会话对象换成宿主认的会话 id。
   *
   * `ctx.agents.get()` 与端点都只认 id 字符串。会话对象上的 `id` 是唯一稳定标识；
   * 取不到就返回 undefined，调用方一律当"没有 live agent"处理。
   *
   * @param {unknown} session - 会话。
   * @returns {string|undefined} 会话 id。
   */
  function sessionKey(session) {
    const id = /** @type {{id?: unknown}} */ (session)?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * 找出这一步到底说的是哪个会话。
   *
   * 两条来源：浏览器把 `sessionId` 写在查询串（面板读状态）或请求体（弹窗答复）里。
   * 有 id 才查得到会话对象——**不接受"猜一个"**，认不出来就返回 undefined，端点
   * 回 400，而不是把金额或拦截状态记到别的会话头上。
   *
   * @param {string} url - 请求 url。
   * @param {unknown} [bodyId] - 请求体里的 `sessionId`。
   * @returns {object|undefined} 会话对象。
   */
  const guardTarget = (url, bodyId) => limitTarget(typeof bodyId === 'string' && bodyId !== '' ? bodyId : querySessionId(url))

  /**
   * 从查询串里取会话 id。
   *
   * @param {string} url - 请求 url。
   * @returns {string|undefined} 会话 id。
   */
  function querySessionId(url) {
    const index = typeof url === 'string' ? url.indexOf('?') : -1
    if (index < 0) return undefined
    try {
      const value = new URLSearchParams(url.slice(index)).get('sessionId')
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 会话 id → 会话对象。
   *
   * 优先问宿主（有活着的 agent 就有会话对象）；问不到再翻我们自己记过的记录
   * （已归档、宿主刚重启的会话仍要能读到金额与最初的提示词）。
   *
   * @param {unknown} id - 会话 id。
   * @returns {object|undefined} 会话对象；认不出来返回 undefined。
   */
  const limitTarget = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    const agent = agents?.get?.(id)
    if (agent?.session !== undefined) return agent.session
    // 会话当前没有活着的 agent（已归档、宿主刚重启）：记录是按 id 存的，直接认这份 id。
    return guards.has(id) ? { id } : undefined
  }

  /**
   * 用户验证通过后下的"按原要求继续"指令。
   *
   * 关键词只有两个：**从停下的地方继续**（别从头重做）、**保持原来的要求与判断**
   * （别趁机改需求）。推理等级不在这里提——插件根本不动档位，会话里原来选的是
   * 什么就还是什么。
   */
  const CONTINUE_INSTRUCTION = [
    '花费预警已由用户验证放行：继续这个会话原来那件事。',
    '',
    '要求：',
    '1. 从刚才被打断的地方接着做，不要从头重做，也不要重复已经完成的步骤。',
    '2. 需求、范围、判断标准都和之前完全一致；这条消息不是新需求，不要改目标。',
    '3. 直接继续干活，不用回答这条消息、不要复述它。',
  ].join('\n')

  /**
   * 用户验证通过后，给本会话的模型下一条"按原要求继续"的指令。
   *
   * 走 `agent.followup()`：这就是宿主"排队一条用户消息并唤醒"的公开入口。
   * **不改任何档位**，所以推理等级沿用上一轮用户在界面上选的/会话已有的值。
   * 终止那一侧不下任何指令——终止只显示本会话最初的提示词，不碰文件。
   *
   * @param {unknown} session - 会话。
   * @param {string} text - 指令正文。
   * @returns {{delivered: boolean, reason?: string}} 投递结果。
   */
  const instruct = (session, text) => {
    const key = sessionKey(session)
    const agent = key === undefined ? undefined : agents?.get?.(key)
    if (agent === undefined || typeof agent.followup !== 'function') return { delivered: false, reason: 'no-agent' }
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'optimizer' },
      })
      costStats.woken += 1
      return { delivered: true }
    } catch (error) {
      costStats.failed += 1
      warn(`cost guard followup failed: ${error?.message ?? error}`)
      return { delivered: false, reason: 'followup-failed' }
    }
  }

  // 会话投影：把拦截状态与金额同步给浏览器（弹窗就是靠它弹出的）。
  const projections = service('sessionProjections')
  /** 会话 id → 活着的 agent。停止键、队列、唤醒都走它，和宿主自己的控制面同一条路。 */
  const agents = service('agents')
  if (typeof projections?.register === 'function') {
    ctx.effect(
      () => guard('cost guard projection', () => projections.register({
        key: GUARD_PROJECTION_KEY,
        init: () => guardView(undefined),
        apply: (state, event) => {
          const session = event?.session
          return session === undefined ? state : guardWire(guardView(session))
        },
        wire: { view: (state) => state },
      })),
      'optimizer: cost guard projection',
    )
  }

  /**
   * 每个会话的拦截状态，以及"最初让他做什么"。
   *
   * 拦截来自 `session/event`：**花费只在这里变**，所以判定与界面上的数字永远同源。
   * `agent/pre-step` 只做兜底——万一某一轮没被取消掉（用户手动取消、宿主重启），
   * 已经拦下的会话不会靠下一条消息偷偷续跑。
   */
  ctx.effect(
    () =>
      guard('cost guard hook', () =>
        ctx.on('session/event', (session, event) => {
          try {
            const key = sessionKey(session)
            if (key === undefined) return
            costLedger.record(key, event)
            enforce(session)
          } catch (error) {
            warn(`cost guard fold failed: ${error?.message ?? error}`)
          }
        }),
      ),
    'optimizer: cost guard events',
  )

  ctx.effect(
    () =>
      guard('cost guard backstop', () =>
        ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
          const session = agent?.session
          try {
            if (session !== undefined) {
              rememberPrompt(session, messages)
              const record = guardOf(session)
              const spend = costLedger.peek(sessionKey(session))
              if (!record.cancelled && spend !== undefined && overBudget(spend, limitNanos(session), guardState.get())) {
                if (record.guard !== 'tripped') {
                  record.guard = 'tripped'
                  record.hits += 1
                  record.at = Date.now()
                  costStats.blocked += 1
                }
                return { kind: 'reject' }
              }
            }
          } catch (error) {
            warn(`cost guard backstop failed: ${error?.message ?? error}`)
          }
          return next()
        }),
      ),
    'optimizer: cost guard backstop',
  )

  // --- 推理等级：每个 turn 的起点判一次 ----------------------------------------
  ctx.effect(
    () =>
      guard('classify hook', () =>
        ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
          const decision = await next()
          try {
            const record = ledger.of(agent.session)
            const moved = record.turn !== turn || record.step !== step
            record.turn = turn
            record.step = step
            const texts = Array.isArray(messages) ? messages.map(messageText).filter((text) => text !== '') : []
            // 没有新用户消息（续跑、重试）就不再判：同一轮里档位保持稳定。
            if (texts.length > 0 && (moved || record.bucket === undefined)) {
              const judged = classifyMessage(
                texts[texts.length - 1],
                record.bucket === undefined ? {} : { bucket: record.bucket },
              )
              record.bucket = judged.bucket
              effortStats.recordTurn(judged.bucket, judged.inherited)
              if (config.log) warn(`judge ${judged.bucket}${judged.inherited ? ' (inherited)' : ''}`)
            }
          } catch (error) {
            effortStats.failed += 1
            warn(`classify failed: ${error?.message ?? error}`)
          }
          return decision
        }),
      ),
    'optimizer: classify per turn',
  )

  // --- 推理等级：把档位写进这一次调用 ------------------------------------------
  ctx.effect(
    () =>
      guard('request hook', () =>
        ctx.on('agent/request', async ({ agent }, next) => {
          const resolved = await next()
          const session = agent?.session
          try {
            if (session === undefined) return resolved
            const record = ledger.of(session)
            const why = !autoState.get() ? 'off' : record.manual === true ? 'manual' : record.bucket === undefined ? 'no-bucket' : undefined
            if (why !== undefined) {
              effortStats.skipped += 1
              effortStats.push({ kind: 'skip', why, bucket: record.bucket ?? null, has: resolved?.reasoningEffort ?? null })
              return resolved
            }
            // 让位的判据只有一个：会话投影里出现"用户刚选过"（pending）。
            // 曾经用"这次头里的档位和我上次写的不一样"当第二判据——实测有害：
            // 头是持久化的、投影却可能落后一轮，于是插件会把自己上一轮的写入
            // 误认成用户手选，然后永久停手（表现为"开了 auto 却再也不改档位"）。
            if (pendingSelection(session)) {
              record.manual = true
              effortStats.skipped += 1
              effortStats.push({ kind: 'yield', bucket: record.bucket, model: `${resolved?.provider}/${resolved?.model}`, has: resolved?.reasoningEffort ?? null })
              return resolved
            }
            const decided = resolveEffort({
              bucket: record.bucket,
              reasoning: await reasoningFor(resolved?.provider, resolved?.model),
              forced: config.force ?? (config.levels === undefined ? undefined : config.levels[record.bucket]),
            })
            const wanted = decided.effort
            if (wanted === undefined || wanted === resolved?.reasoningEffort) {
              effortStats.skipped += 1
              effortStats.push({
                kind: 'skip',
                why: wanted === undefined ? 'no-level' : 'same',
                bucket: record.bucket,
                model: `${resolved?.provider}/${resolved?.model}`,
                has: resolved?.reasoningEffort ?? null,
                levels: decided.levels,
              })
              return resolved
            }
            record.applied = wanted
            effortStats.applied += 1
            effortStats.push({
              kind: 'apply',
              bucket: record.bucket,
              model: `${resolved?.provider}/${resolved?.model}`,
              from: resolved?.reasoningEffort ?? null,
              to: wanted,
            })
            if (config.log) warn(`apply ${record.bucket} → ${wanted} (${resolved?.provider}/${resolved?.model})`)
            return { ...resolved, reasoningEffort: wanted }
          } catch (error) {
            effortStats.failed += 1
            warn(`apply failed: ${error?.message ?? error}`)
            return resolved
          }
        }),
      ),
    'optimizer: apply effort',
  )

  ctx.effect(
    () =>
      guard('dispose hook', () =>
        ctx.on('agent/disposed', ({ agent }) => {
          if (agent?.session !== undefined) ledger.drop(agent.session)
          // 花费折子与拦截记录都按会话 id 记，会话销毁时一起丢掉。
          const key = agent?.session === undefined ? undefined : sessionKey(agent.session)
          if (key !== undefined) {
            costLedger.drop(key)
            guards.delete(key)
          }
        }),
      ),
    'optimizer: forget disposed session',
  )

  // 段落注册：开关可用与否都不该影响"段落是否注册"这条主线。
  // 段落名与别的插件撞车时宿主会抛错——经过 guard 后只丢段落，推理等级照常工作。
  ctx.effect(
    () =>
      guard('prompt section', () =>
        service('systemPrompt')?.section?.({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: () => {
            const enabled = state.get()
            stats.record(enabled)
            if (config.log) ctx?.logger?.info?.(`optimizer: assemble ${enabled ? 'inject' : 'skip'}`)
            return resolveDirective(enabled)
          },
        }),
      ),
    'optimizer: prompt section',
  )

  // 状态已在构造时同步读回；这里只在开了 log 时说明一句。
  if (config.log) {
    warn(`restored auto=${autoState.get()} concise=${state.get()}`)
  }

  // 浏览器开关：同源 JSON 端点。注册失败不影响提示词段落与推理等级。
  const webServer = service('webServer')
  if (webServer?.register !== undefined) {
    ctx.effect(
      () =>
        guard('toggle endpoint', () => webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          /**
           * @param {import('node:http').IncomingMessage} req - 请求。
           * @param {import('node:http').ServerResponse} res - 响应。
           */
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const url = typeof req.url === 'string' ? req.url : ''
              const diagnostic = url.includes('diag=1')
              const wantsGuard = url.includes('guard=1')
              /** 面板问的是"这个会话"的预值：不带 sessionId 就没有预值可谈。 */
              const panelTarget = limitTarget(querySessionId(url))
              /** 面板问"这个会话现在什么情况"时，把金额与拦截状态一起给它。 */
              const session = wantsGuard ? guardTarget(url) : undefined
              sendJson(res, 200, {
                // 通用开关协议：面板按每个开关自己的 `field` 读值。
                enabled: state.get(),
                auto: autoState.get(),
                costGuard: guardState.get(),
                costLimit: panelTarget === undefined ? 0 : limitYuan(panelTarget),
                hasSession: panelTarget !== undefined,
                ...wantsGuard
                  ? {
                    guard: session === undefined ? undefined : guardWire(guardView(session)),
                    prompt: session === undefined ? '' : guardOf(session).prompt,
                  }
                  : {},
                // 面板的开关登记表：三个开关，各一个字段。
                switches: [
                  {
                    id: 'auto',
                    label: { zh: '推理等级 auto', en: 'Reasoning effort auto' },
                    hint: {
                      zh: '按每个请求的轻重自动选推理档位：闲聊与轻活少想，重活多想。你在模型选择器里手选的档位优先。',
                      en: 'Picks the reasoning effort per request: light for chat, more for hard work. A level you pick yourself always wins.',
                    },
                    endpoint: ROUTE_PATH,
                    field: 'auto',
                  },
                  {
                    id: 'concise',
                    label: { zh: '精简化输出', en: 'Concise output' },
                    hint: {
                      zh: '压掉开场白与复述，只留事实与下一步；任务内容一个字不变。',
                      en: 'Drops preambles and restatements; the task itself is unchanged.',
                    },
                    endpoint: ROUTE_PATH,
                    field: 'enabled',
                  },
                  {
                    id: 'costGuard',
                    label: { zh: '花费预警', en: 'Cost warning' },
                    hint: {
                      zh: '**本会话**花费达到右边填的预值（元）时停住这一轮，弹窗询问是否继续；继续要先验证六位数字。填一个正数会自动打开本开关；填 0 = 不限。每个会话各填各的，互不影响。',
                      en: 'When THIS session reaches the limit on the right (CNY), the turn stops and a dialog asks whether to continue; continuing requires the six-digit code. A positive number switches this on; 0 means no limit. Each session keeps its own limit.',
                    },
                    endpoint: ROUTE_PATH,
                    field: 'costGuard',
                    // 面板据此在标题后面长出一个自定义数字框；值是元，允许小数。
                    input: {
                      field: 'costLimit',
                      unit: { zh: '元', en: 'CNY' },
                      placeholder: { zh: '预值', en: 'limit' },
                      hint: {
                        zh: '每个会话独立：这里填的是**当前这个会话**的预值。0 或留空 = 不限，填正数会自动打开开关。到预值只是暂停，不是失败。',
                        en: 'Per session: this is the limit for the CURRENT session. 0 or empty means no limit; a positive number switches this on. Reaching it pauses the turn, it does not fail.',
                      },
                    },
                  },
                ],
                config: {
                  autoDefault: config.autoDefault,
                  conciseDefault: config.conciseDefault,
                  costGuardDefault: config.costGuardDefault,
                  costLimitDefault: config.costLimitDefault,
                  persist: config.persist,
                  force: config.force ?? null,
                  levels: config.levels ?? null,
                  section: SECTION_NAME,
                  order: SECTION_ORDER,
                },
                stats: stats.snapshot(),
                ...diagnostic
                  ? {
                    effort: effortStats.snapshot(),
                    cost: costStats.snapshot(),
                    sessions: ledger.records.size,
                    costSessions: costLedger.records.size,
                    guards: guards.size,
                    limitNanos: defaultLimit,
                    // 盘上还留着旧单位的键？说一声。旧值是微元，新代码按纳元读会把预值
                    // 放大 1000 倍（等于悄悄失效），所以升级后要重新填一次预值。
                    staleLimit: staleLimitKey(),
                  }
                  : {},
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method-not-allowed' })
              return
            }
            const body = await readJsonBody(req)
            if (body === undefined) {
              sendJson(res, 400, { error: 'invalid-body' })
              return
            }
            // 弹窗的两个答复：放行（验证通过后继续）与终止（只停手、只回看最初的提示词）。
            if (typeof body.guardAction === 'string') {
              const session = guardTarget(typeof req.url === 'string' ? req.url : '', body.sessionId)
              if (session === undefined) {
                sendJson(res, 400, { error: 'unknown-session' })
                return
              }
              const record = guardOf(session)
              if (body.guardAction === 'continue') {
                record.guard = 'woke'
                const delivered = instruct(session, CONTINUE_INSTRUCTION)
                sendJson(res, 200, { guardAction: 'continue', delivered: delivered.delivered, ...delivered.reason === undefined ? {} : { why: delivered.reason } })
                return
              }
              if (body.guardAction === 'terminate') {
                // 终止 = 停手 + 把最初的提示词交还给用户看。**不下任何删除指令**：
                // 删什么是用户的决定，插件不替他给模型下破坏性的活儿。
                // 会话此刻可能已经不在跑（拦截时就取消过），所以这里容错。
                record.guard = 'terminated'
                record.cancelled = true
                const key = sessionKey(session)
                const agent = key === undefined ? undefined : agents?.get?.(key)
                try {
                  if (agent?.status === 'running') agent.cancel({ kind: 'hook', reason: 'optimizer:cost-guard-terminate' }, { keepInbox: true })
                } catch (error) {
                  warn(`cost guard terminate cancel failed: ${error?.message ?? error}`)
                }
                sendJson(res, 200, { guardAction: 'terminate', terminated: true, prompt: record.prompt })
                return
              }
              sendJson(res, 400, { error: 'unknown-action' })
              return
            }
            let changed = false
            if (typeof body.auto === 'boolean') {
              autoState.set(body.auto)
              // 重新打开 auto 时忘掉"用户手选过"，否则开关看起来没反应。
              if (body.auto) ledger.unlock()
              changed = true
            }
            if (typeof body.enabled === 'boolean' || typeof body.concise === 'boolean') {
              const next = typeof body.enabled === 'boolean' ? body.enabled : body.concise
              state.set(next === true)
              changed = true
            }
            if (typeof body.costGuard === 'boolean') {
              guardState.set(body.costGuard)
              changed = true
            }
            if (body.costLimit !== undefined) {
              const nanos = toNanos(body.costLimit)
              if (nanos === undefined) {
                sendJson(res, 400, { error: 'invalid-limit' })
                return
              }
              // 预值按会话独立：写之前必须知道是哪个会话。不知道就拒掉，
              // **绝不**回退成"写进一个全局值"——那正是上一个版本的坑：
              // A 会话设的额度会拦到 B 会话头上。
              const target = limitTarget(body.sessionId ?? querySessionId(typeof req.url === 'string' ? req.url : ''))
              if (target === undefined) {
                sendJson(res, 400, { error: 'unknown-session' })
                return
              }
              guardOf(target).limit = nanos
              // 填了一个**正数**预值 = 你就是想让它拦：顺手把开关打开。否则用户输完
              // 数字、以为已经生效，实际开关还关着——"填了预值却没反应"的老毛病。
              // 填 0（= 不限）不动开关：那是在表达"别拦"，不该把开关点开。
              if (nanos > 0 && guardState.get() !== true) guardState.set(true)
              changed = true
              // 立刻按新预值重判这个会话：改小立刻拦，改大立刻松开。
              enforce(target)
            }
            if (typeof body.costGuard === 'boolean' || body.auto !== undefined || typeof body.enabled === 'boolean') {
              // 开关一改，所有会话的判据都变了：都重判一遍。
              for (const id of guards.keys()) enforce({ id })
            }
            if (changed) {
              const target = limitTarget(body.sessionId ?? querySessionId(typeof req.url === 'string' ? req.url : ''))
              sendJson(res, 200, {
                auto: autoState.get(),
                enabled: state.get(),
                costGuard: guardState.get(),
                costLimit: target === undefined ? 0 : limitYuan(target),
              })
              return
            }
            sendJson(res, 400, { error: 'invalid-body' })
          },
        })),
      'optimizer: toggle endpoint',
    )
  } else {
    ctx?.logger?.warn?.('optimizer: webServer unavailable, running without the UI switch')
  }

  return { state, autoState, guardState, config, stats, effortStats, costStats, ledger, costLedger, guards, limitYuan }
}
