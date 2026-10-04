/**
 * dsh-optimizer —— 优化插件集（宿主半边）。
 *
 * ## 这个插件只做一件事
 *
 * 在系统提示词的**最后**追加一段输出纪律，要求模型把回复里"任务内容之外"的部分
 * 压到最少：零开场白、零复述、零装饰性小节，只留事实、代码、命令、路径、风险与下一步。
 *
 * ## 为什么这样省 token 而不动任务
 *
 * 提示词段落是"生成前约束"，不是"生成后裁剪"。模型写文件、跑命令、装文档时走的路
 * 与不装插件时完全一致；被省掉的只有它本来会写、而你没在看的那些字。所以 Word/PPT/
 * 代码这类交付物的内容与质量与不装插件时一致。
 *
 * ## 为什么开关能"立刻"生效
 *
 * `systemPrompt.section({ text })` 的 `text` 是函数：每次请求装配前重新求值。开关一改，
 * 下一个模型步骤就是新行为——不需要重载插件、不需要重启。关闭时返回空串，宿主会把
 * 整段丢掉（`renderPrompt` 过滤空文本），不占 token。
 *
 * ## 代价：一次前缀缓存失效
 *
 * 段落恒定在系统提示词末尾，开关不变时它逐字节稳定，不产生额外缓存失效；只有你
 * **主动**拨开关的那一次，会从这一段起重新计费一次。
 *
 * ## 装配永不失败
 *
 * 失败模式只有一个方向是安全的：状态读不出、盘写不了、路由注册失败，都必须退回
 * "原样工作"，而不是让模型收到半截指令或让宿主拒绝启动。
 *
 * @module dsh-optimizer
 */

import { ConciseState, resolveDshHome, statePath } from './state.js'
import { resolveDirective } from './directive.js'
import { Config, resolveConfig } from './schema.js'

/** 插件名。 */
export const name = 'optimizer'

export { Config }

/** 需要的服务：提示词段落面 + 浏览器开关的通路。 */
export const inject = ['systemPrompt', 'webServer']

/** 浏览器开关的端点路径。 */
export const ROUTE_PATH = '/dsh-optimizer'

/** 段落在系统提示词里的名字。**必须唯一**：与别的插件撞名会被宿主拒绝注册。 */
export const SECTION_NAME = 'optimizer:concise'

/** 段落顺序：恒定在最后，不动前面任何一段的前缀缓存。 */
export const SECTION_ORDER = 10200

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

  const stats = new AssembleStats()

  // 段落注册：开关可用与否都不该影响"段落是否注册"这条主线。
  ctx.effect(
    () =>
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
    'optimizer: prompt section',
  )

  // 状态恢复：只在"配置允许"时读盘；读不到保持默认。
  ctx.effect(() => {
    void state.load().then((loaded) => {
      if (loaded && config.log) ctx?.logger?.info?.(`optimizer: restored enabled=${state.get()}`)
    })
    return () => {}
  }, 'optimizer: state load')

  // 浏览器开关：同源 JSON 端点。注册失败不影响提示词段落。
  const webServer = service('webServer')
  if (webServer?.register !== undefined) {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          /**
           * @param {import('node:http').IncomingMessage} req - 请求。
           * @param {import('node:http').ServerResponse} res - 响应。
           */
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              sendJson(res, 200, {
                // 通用开关协议：面板只认 `enabled`（本插件只有这一个开关）。
                enabled: state.get(),
                // 面板的开关登记表。
                switches: [
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
                  conciseDefault: config.conciseDefault,
                  persist: config.persist,
                  section: SECTION_NAME,
                  order: SECTION_ORDER,
                },
                stats: stats.snapshot(),
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
            if (typeof body.enabled === 'boolean' || typeof body.concise === 'boolean') {
              const next = typeof body.enabled === 'boolean' ? body.enabled : body.concise
              sendJson(res, 200, { enabled: state.set(next === true) })
              return
            }
            sendJson(res, 400, { error: 'invalid-body' })
          },
        }),
      'optimizer: toggle endpoint',
    )
  } else {
    ctx?.logger?.warn?.('optimizer: webServer unavailable, running without the UI switch')
  }

  return { state, config, stats }
}
