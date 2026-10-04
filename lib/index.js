/**
 * dsh-optimizer —— 优化插件集（宿主半边）。
 *
 * ## 两个开关
 *
 * 1. **推理等级 auto**：每个 turn 的起点判一次"这活儿有多重"，把结果落成该模型**真实
 *    支持**的推理档位。轻活少想，重活多想；判不出来就用模型默认。挂的是两个宿主公开
 *    的契约事件（`agent/pre-step` 判组、`agent/request` 落地），**不包任何模型调用
 *    路径、不改模型目录、不碰模型选择器**。
 * 2. **精简化输出**：在系统提示词**最后**追加一段输出纪律，要求模型把回复里"任务内容
 *    之外"的部分压到最少：零开场白、零复述、零装饰性小节。提示词段落是"生成前约束"，
 *    不是"生成后裁剪"，所以交付物的内容与质量与不装插件时一致。
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
 * 这次请求用模型默认档位，而不是请求失败。注册类动作（段落、端点、监听）全部经过
 * `guard()`：其中任何一项失败只丢掉它自己，不影响其它功能。
 *
 * ## 装配永不失败
 *
 * 读不出状态、写不进盘、注册被拒，都退回"能跑的那部分照常跑"。
 *
 * @module dsh-optimizer
 */

import { classifyMessage } from './classify.js'
import { resolveEffort } from './efforts.js'
import { ConciseState, ToggleState, resolveDshHome, statePath } from './state.js'
import { resolveDirective } from './directive.js'
import { Config, resolveConfig } from './schema.js'

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

  const stats = new AssembleStats()
  const effortStats = new EffortStats()
  const ledger = new Ledger()
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
              const diagnostic = typeof req.url === 'string' && req.url.includes('diag=1')
              sendJson(res, 200, {
                // 通用开关协议：面板按每个开关自己的 `field` 读值。
                enabled: state.get(),
                auto: autoState.get(),
                // 面板的开关登记表：两个开关，各一个字段。
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
                ],
                config: {
                  autoDefault: config.autoDefault,
                  conciseDefault: config.conciseDefault,
                  persist: config.persist,
                  force: config.force ?? null,
                  levels: config.levels ?? null,
                  section: SECTION_NAME,
                  order: SECTION_ORDER,
                },
                stats: stats.snapshot(),
                ...diagnostic ? { effort: effortStats.snapshot(), sessions: ledger.records.size } : {},
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
            if (changed) {
              sendJson(res, 200, { auto: autoState.get(), enabled: state.get() })
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

  return { state, autoState, config, stats, effortStats, ledger }
}
