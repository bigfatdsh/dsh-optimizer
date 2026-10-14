/**
 * 宿主半边：段落注册、开关读写、注入内容、失败方向。
 *
 * 精简化只有两个必须成立的事实：
 *   1. 系统提示词里**恒定**有这一段（名字唯一、位置在最后）；
 *   2. 开关一改，下一个请求装配时注入的内容就跟着变（关闭时是空串，不占 token）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROUTE_PATH, SECTION_NAME, SECTION_ORDER, apply, inject, name } from '../lib/index.js'
import { statePath } from '../lib/state.js'
import { DIRECTIVE, resolveDirective } from '../lib/directive.js'

/**
 * 假宿主：只实现插件用到的那部分服务。
 *
 * @param {object} [options] - `{ withWebServer, withSystemPrompt }`。
 * @returns {object} 句柄。
 */
function fakeHost(options = {}) {
  const sections = []
  const routes = []
  const logs = []
  const listeners = new Map()
  const services = {}
  /** 注册过的会话投影定义：花费预警靠它把金额同步给浏览器。 */
  const projections = []
  /** 假 agent：只实现插件真的会用到的那几件事。 */
  const agents = options.agents ?? new Map()
  if (options.projections !== undefined) {
    services.sessionProjections = {
      stateOf: (session) => options.projections(session),
    }
  }
  if (options.withCostProjection !== false) {
    services.sessionProjections = {
      ...services.sessionProjections,
      register: (definition) => {
        projections.push(definition)
        return () => {}
      },
    }
    services.agents = { get: (id) => agents.get(id) }
  }
  if (options.models !== undefined) {
    const table = new Map(options.models.map((model) => [model.id, model]))
    services.llm = {
      async resolveModelInfo(_provider, model) {
        const found = table.get(model)
        if (found === undefined) throw new Error(`no such model: ${model}`)
        return found
      },
      async listModels() {
        // 真实行为：目录投影**故意不含** reasoning。旧实现就是被这一点坑到的。
        return options.models.map(({ id, name }) => ({ id, name: name ?? id }))
      },
    }
  }
  if (options.withSystemPrompt !== false) {
    services.systemPrompt = {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    }
  }
  if (options.withWebServer !== false) {
    services.webServer = {
      register(route) {
        routes.push(route)
        return () => {}
      },
    }
  }
  const ctx = {
    get: (key) => services[key],
    effect(fn) {
      fn()
      return () => {}
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(handler), 1)
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  }
  /** 触发一个事件，按注册顺序串成 waterfall。 */
  const fire = async (event, payload, next) => {
    const list = listeners.get(event) ?? []
    let chain = next
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const handler = list[index]
      const downstream = chain
      chain = () => handler(payload, downstream)
    }
    return chain()
  }
  const route = () => routes.find((entry) => entry.path === ROUTE_PATH)
  /** 一次 GET/HEAD；`url` 带查询串时能测 `?guard=1` 这类分支。 */
  const request = async (method, url, body) => {
    const incoming = (async function* chunks() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    })()
    incoming.method = method
    incoming.url = url
    const out = []
    await route().handler(incoming, { writeHead(status) { out.push(status) }, end(payload) { out.push(JSON.parse(payload.toString('utf8'))) } })
    return out
  }
  const read = async (url = ROUTE_PATH) => {
    const out = await request('GET', url)
    return out[out.length - 1]
  }
  /**
   * 一次 POST。`url` 可以带查询串——预值按会话独立，宿主就是靠 `?sessionId=` 认会话的。
   *
   * @param {object} body - 请求体。
   * @param {string} [url] - 端点（可带查询串）。
   * @returns {Promise<Array>} `[status, body]`。
   */
  const post = async (body, url = ROUTE_PATH) => request('POST', url, body)
  /** 带会话的端点：面板与弹窗发的都是这个形状。 */
  const withSession = (sessionId) => `${ROUTE_PATH}?sessionId=${encodeURIComponent(sessionId)}`
  /**
   * 发一条会话事件：`session/event` 的 payload 是 `(session, event)`，不是对象。
   */
  const emit = (session, event) => {
    for (const handler of listeners.get('session/event') ?? []) handler(session, event)
  }
  return { ctx, sections, routes, logs, listeners, route, read, post, request, fire, emit, projections, agents, withSession }
}

/** 一条用户消息。 */
const userMessage = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/**
 * 走一步：先判组，再落地。
 *
 * turn/step 每次自增：同一个 (turn, step) 再来一次在宿主里不会发生，插件据此判断
 * "这一轮没有新用户消息"。测试也必须照这个真实来。
 */
async function step(host, session, text, resolved) {
  session.turn = (session.turn ?? 0) + 1
  const position = { turn: session.turn, step: 1 }
  await host.fire('agent/pre-step', { agent: { session }, messages: [userMessage(text)], ...position }, async () => ({ kind: 'enter' }))
  return host.fire('agent/request', { agent: { session }, ...position }, async () => resolved)
}

/** DeepSeek 目录里的真实形状。 */
const DEEPSEEK_MODELS = [{
  id: 'deepseek-chat',
  reasoning: {
    efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }],
    defaultEffort: 'high',
  },
}]

/** 一份临时 DSH 主目录，避免写到真实 home。 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'concise-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('清单：名字、依赖与端点', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-optimizer', '包名要与客户端注册 id 一致')
  assert.equal(name, 'optimizer')
  assert.deepEqual(inject, ['systemPrompt', 'webServer'])
  assert.equal(ROUTE_PATH, '/dsh-optimizer')
  assert.equal(pkg.dsh.client.inject[0], '@deepseek-ai/dsh-client-ui-conversation')
})

test('段落：恒定注册，名字唯一、位置在最后', () => {
  const host = fakeHost()
  apply(host.ctx, { log: false })
  assert.equal(host.sections.length, 1, '必须注册且只注册一段')
  assert.equal(host.sections[0].name, SECTION_NAME)
  assert.equal(host.sections[0].name, 'optimizer:concise', '名字不能借用别人的（撞名会被宿主拒绝，整个插件被丢弃）')
  assert.equal(host.sections[0].order, SECTION_ORDER)
  assert.ok(SECTION_ORDER >= 10000, '必须排在系统提示词最后，不动前面段落的前缀缓存')
  assert.equal(typeof host.sections[0].text, 'function', 'text 必须是函数：每次装配前重新求值')
})

test('注入内容：关闭是空串（不占 token），开启是完整指令', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { conciseDefault: false, log: false })
    const text = () => host.sections[0].text()
    assert.equal(text(), '', '默认关闭：宿主会丢弃整段')
    await host.post({ enabled: true })
    assert.equal(text(), DIRECTIVE, '开启后注入的就是那段指令')
    assert.match(text(), /Write only what the user needs to act/)
    await host.post({ enabled: false })
    assert.equal(text(), '', '关掉立刻回到空串')
  })
})

test('开关：GET 报状态与登记表，POST 写入并回报', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { conciseDefault: true, log: false })
    const initial = await host.read()
    assert.equal(initial.enabled, true, 'conciseDefault: true 时首次就是开')
    // 面板读的是登记表：三个开关，各一个字段，字段名不能重复。
    assert.deepEqual(initial.switches.map((item) => item.field), ['auto', 'enabled', 'costGuard'])
    assert.deepEqual(initial.switches.map((item) => item.endpoint), [ROUTE_PATH, ROUTE_PATH, ROUTE_PATH])
    assert.equal(initial.auto, true, 'autoDefault 默认开')
    assert.equal(initial.config.section, SECTION_NAME)

    // auto 开关独立读写，不串到精简化那个字段。
    const autoOff = await host.post({ auto: false })
    assert.equal(autoOff[1].auto, false)
    assert.equal(autoOff[1].enabled, true, '关 auto 不该关掉精简化')
    assert.equal(handle.autoState.get(), false)
    assert.equal((await host.read()).auto, false)
    assert.equal((await host.post({ auto: true }))[1].auto, true)

    const off = await host.post({ enabled: false })
    assert.equal(off[0], 200)
    assert.equal(off[1].enabled, false)
    assert.equal((await host.read()).enabled, false)
    assert.equal(handle.state.get(), false)

    // 旧字段名 `concise` 也接受（面板早期版本发的是它）
    assert.equal((await host.post({ concise: true }))[1].enabled, true)
  })
})

test('开关：坏方法、坏请求体都被明确拒绝，不影响开关', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { conciseDefault: true, log: false })
    const out = []
    await host.route().handler({ method: 'DELETE', url: ROUTE_PATH }, { writeHead(s) { out.push(s) }, end() {} })
    assert.equal(out[0], 405)
    const request = (async function* chunks() {
      yield Buffer.from('not json', 'utf8')
    })()
    request.method = 'POST'
    request.url = ROUTE_PATH
    await host.route().handler(request, { writeHead(s) { out.push(s) }, end() {} })
    assert.equal(out[1], 400)
    assert.equal((await host.read()).enabled, true, '坏请求不能改动开关')
  })
})

test('持久化：写盘后能读回，文件是完整 JSON', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    const handle = apply(host.ctx, { conciseDefault: false, log: false })
    handle.state.set(true)
    const raw = await readFile(join(home, 'optimizer.json'), 'utf8')
    assert.deepEqual(JSON.parse(raw), { concise: true })

    // 新实例读回盘上的值
    const second = fakeHost()
    const reloaded = apply(second.ctx, { conciseDefault: false, log: false })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reloaded.state.get(), true, '重启后应恢复上次选择')
  })
})

test('持久化：盘上文件坏掉时退回默认值，不抛错', async () => {
  await withTempHome(async (home) => {
    await writeFile(join(home, 'optimizer.json'), '{ not json', 'utf8')
    const host = fakeHost()
    const handle = apply(host.ctx, { conciseDefault: true, log: true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(handle.state.get(), true, '读坏时保持默认值')
    assert.ok(host.logs.some((line) => line.startsWith('WARN')), '读坏要出声（警告），不能静默')
  })
})

test('缺少服务时不炸：没有 webServer 就没有开关，段落照旧注册', () => {
  const host = fakeHost({ withWebServer: false })
  assert.doesNotThrow(() => apply(host.ctx, { log: true }))
  assert.equal(host.sections.length, 1, '段落注册不受影响')
  assert.ok(host.logs.some((line) => line.includes('webServer unavailable')))
})

test('缺少 systemPrompt 时不炸，只是不注入', () => {
  const host = fakeHost({ withSystemPrompt: false })
  assert.doesNotThrow(() => apply(host.ctx, { log: false }))
  assert.equal(host.sections.length, 0)
})

test('指令文本：逐条保留清单，且要求"任务本身一字不改"', () => {
  assert.match(DIRECTIVE, /No preamble/)
  assert.match(DIRECTIVE, /same steps, same tools, same files/)
  assert.match(DIRECTIVE, /Keep all facts, numbers, code, commands, paths/)
  assert.match(DIRECTIVE, /Never omit what you could not do/)
  assert.equal(resolveDirective(true), DIRECTIVE)
  assert.equal(resolveDirective(false), '')
  assert.equal(resolveDirective(undefined), '')
})

test('统计：只记数字，装配次数与注入次数都对得上', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { conciseDefault: false, log: false })
    const text = () => host.sections[0].text()
    text()
    text()
    await host.post({ enabled: true })
    text()
    assert.deepEqual(handle.stats.snapshot(), { assembled: 3, injected: 1 })
  })
})

// --- 推理等级 auto：必须成立的行为 ------------------------------------------

test('auto：重活抬到 max，闲聊压到 off，提问落 low', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  apply(host.ctx, { conciseDefault: false, autoDefault: true, persist: false })
  const call = (text, resolved) => step(host, {}, text, resolved)
  const base = { provider: 'deepseek', model: 'deepseek-chat' }

  assert.equal((await call('帮我从零搭建一套订单系统的架构设计，要考虑分库分表和缓存策略', { ...base, reasoningEffort: 'high' })).reasoningEffort, 'max')
  assert.equal((await call('你好', base)).reasoningEffort, 'off')
  assert.equal((await call('什么是防抖', base)).reasoningEffort, 'low')
})

test('auto 关掉后一个字段都不动，且是同一个对象', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  apply(host.ctx, { autoDefault: false, persist: false })
  const resolved = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
  const after = await step(host, {}, '帮我从零重写整个鉴权模块', resolved)
  assert.equal(after, resolved, '必须原样返回同一个对象')
})

test('auto：模型不支持推理时透传，不抛错', async () => {
  const host = fakeHost({ models: [{ id: 'plain', reasoning: undefined }] })
  apply(host.ctx, { autoDefault: true, persist: false })
  const resolved = { provider: 'deepseek', model: 'plain' }
  assert.deepEqual(await step(host, {}, '帮我改一下这个函数', resolved), resolved)
})

test('auto：目录投影（listModels）里没有 reasoning 时不会被当成"不支持推理"', async () => {
  // 这是真实踩过的坑：listModels 只给 provider/id/name/description/inputModalities。
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  const handle = apply(host.ctx, { autoDefault: true, persist: false })
  const applied = await step(host, {}, '帮我从零重写整个鉴权模块', { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(applied.reasoningEffort, 'max')
  assert.equal(handle.effortStats.snapshot().applied, 1)
})

test('auto：没有 llm 服务时透传，并保持其它功能', async () => {
  const host = fakeHost()
  const handle = apply(host.ctx, { autoDefault: true, persist: false })
  const resolved = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.deepEqual(await step(host, {}, '帮我改一下这个函数', resolved), resolved)
  assert.equal(handle.effortStats.snapshot().applied, 0)
  assert.ok(handle.effortStats.snapshot().turns >= 1, '判组照常记录')
})

test('auto：用户在界面上手选时让位，并且永久停手', async () => {
  let pending = false
  const host = fakeHost({
    models: DEEPSEEK_MODELS,
    projections: () => (pending ? { lastUsed: null, pending: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off' } } : null),
  })
  const handle = apply(host.ctx, { autoDefault: true, persist: false })
  const session = {}
  const base = { provider: 'deepseek', model: 'deepseek-chat' }

  const first = await step(host, session, '帮我从零重写整个鉴权模块', { ...base, reasoningEffort: 'high' })
  assert.equal(first.reasoningEffort, 'max', '第一次由插件定档')

  // 界面产生了一次显式选择：插件必须让位。
  pending = true
  const second = await step(host, session, '你好', { ...base, reasoningEffort: 'off' })
  assert.equal(second.reasoningEffort, 'off')
  assert.equal(handle.ledger.of(session).manual, true)
  assert.ok(handle.effortStats.snapshot().recent.some((entry) => entry.kind === 'yield'))

  // 之后即使回到重活也不再改。
  pending = false
  const third = await step(host, session, '帮我从零重写整个鉴权模块', { ...base, reasoningEffort: 'off' })
  assert.deepEqual(third, { ...base, reasoningEffort: 'off' })
})

test('auto：头里的档位变了不再被当成"用户手选"（这条曾经让 auto 永久停手）', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  const handle = apply(host.ctx, { autoDefault: true, persist: false })
  const session = {}
  const base = { provider: 'deepseek', model: 'deepseek-chat' }

  // 第一轮：插件写 low（light 组）。
  const first = await step(host, session, '什么是防抖', { ...base, reasoningEffort: 'max' })
  assert.equal(first.reasoningEffort, 'low')
  // 第二轮：持久化头里仍是 low，但用户没说任何话（投影里没有 pending）→ 插件必须继续改。
  const second = await step(host, session, '帮我从零重写整个鉴权模块', { ...base, reasoningEffort: 'low' })
  assert.equal(second.reasoningEffort, 'max')
  assert.equal(handle.ledger.of(session).manual, false)
})

test('auto：续跑（没有新用户消息）不重新判，档位保持', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  apply(host.ctx, { autoDefault: true, persist: false })
  const agent = { session: {} }
  await host.fire('agent/pre-step', { agent, messages: [userMessage('帮我从零重写整个鉴权模块')], turn: 1, step: 1 }, async () => ({ kind: 'enter' }))
  await host.fire('agent/pre-step', { agent, messages: [], turn: 1, step: 2 }, async () => ({ kind: 'enter' }))
  const applied = await host.fire('agent/request', { agent, turn: 1, step: 2 }, async () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }))
  assert.equal(applied.reasoningEffort, 'max')
})

test('auto：force 与 levels 覆盖生效；不支持的档位被忽略', async () => {
  const forced = fakeHost({ models: DEEPSEEK_MODELS })
  apply(forced.ctx, { autoDefault: true, persist: false, force: 'low' })
  assert.equal((await step(forced, {}, '帮我从零重写整个鉴权模块', { provider: 'deepseek', model: 'deepseek-chat' })).reasoningEffort, 'low')

  const bogus = fakeHost({ models: DEEPSEEK_MODELS })
  apply(bogus.ctx, { autoDefault: true, persist: false, force: '不存在' })
  assert.equal((await step(bogus, {}, '你好', { provider: 'deepseek', model: 'deepseek-chat' })).reasoningEffort, 'off', '不认识的档位忽略后按判定走')

  const mapped = fakeHost({ models: DEEPSEEK_MODELS })
  apply(mapped.ctx, { autoDefault: true, persist: false, levels: { quiet: 'max' } })
  assert.equal((await step(mapped, {}, '你好', { provider: 'deepseek', model: 'deepseek-chat' })).reasoningEffort, 'max')
})

test('auto：段落重名不让插件死掉，判定照常工作', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  host.ctx.get('systemPrompt').section = () => {
    throw new Error('prompt section "optimizer:concise" is already registered')
  }
  apply(host.ctx, { autoDefault: true, persist: false })
  assert.ok(host.logs.some((line) => line.includes('prompt section unavailable')), '要出声，不能静默')
  const applied = await step(host, {}, '帮我从零重写整个鉴权模块', { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(applied.reasoningEffort, 'max')
})

test('auto：端点注册抛错也不让插件死掉', async () => {
  const host = fakeHost({ models: DEEPSEEK_MODELS })
  host.ctx.get('webServer').register = () => {
    throw new Error('route already taken')
  }
  apply(host.ctx, { autoDefault: true, persist: false })
  assert.ok(host.logs.some((line) => line.includes('toggle endpoint unavailable')))
  const applied = await step(host, {}, '你好', { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(applied.reasoningEffort, 'off')
})

test('auto：两个开关共用一个状态文件，互相不覆盖', async () => {
  const home = await mkdtemp(join(tmpdir(), 'optimizer-'))
  const file = statePath(home)
  try {
    await writeFile(file, '{"concise":true,"auto":true,"别的键":"保留"}', 'utf8')
    const host = fakeHost({ models: DEEPSEEK_MODELS })
    const handle = apply(host.ctx, { autoDefault: false, persist: true, file })
    assert.equal(handle.state.get(), true, '构造时就同步读回（不等下一个 tick）')
    assert.equal(handle.autoState.get(), true, 'auto 也要在第一个请求之前就位')
    assert.equal(handle.autoState.get(), true, 'auto 也从同一个文件读回（缺省只影响没写过的键）')
    await host.post({ auto: true })
    const written = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(written.auto, true)
    assert.equal(written.concise, true)
    assert.equal(written['别的键'], '保留', '不认识的键必须留着')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('auto：messageText 只认用户文本', async () => {
  const { messageText } = await import('../lib/index.js')
  assert.equal(messageText(userMessage('你好')), '你好')
  assert.equal(messageText({ role: 'user', content: 'plain' }), 'plain')
  assert.equal(messageText({ role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: '忽略我' }] }), '')
  assert.equal(messageText({ role: 'user', content: [{ type: 'image' }] }), '')
  assert.equal(messageText(undefined), '')
  assert.equal(messageText(null), '')
})

test('auto：盘上的开关在**构造时**就位，第一个请求不会被默认值抢先', async () => {
  const home = await mkdtemp(join(tmpdir(), 'optimizer-'))
  const file = statePath(home)
  try {
    // autoDefault 是 false，但盘上写着 true —— 真实值必须赢，而且立刻可用。
    await writeFile(file, '{"auto":true,"concise":false}', 'utf8')
    const host = fakeHost({ models: DEEPSEEK_MODELS })
    const handle = apply(host.ctx, { autoDefault: false, persist: true, file })
    assert.equal(handle.autoState.get(), true)
    const applied = await step(host, {}, '帮我从零重写整个鉴权模块', { provider: 'deepseek', model: 'deepseek-chat' })
    assert.equal(applied.reasoningEffort, 'max', '第一个请求就该生效')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- 花费预警 ---------------------------------------------------------------

/**
 * 一条用得起费的 `assistant/message`：默认 1000 未命中 + 500 输出。
 *
 * 2026-01-05 是周一、11:00 北京（高峰），flash 的价目是 miss 2 / out 8 元每百万，
 * 所以这一笔正好 6,000,000 纳元 = 0.006 元。
 */
function usageEvent({ turn = 1, step = 1, model = 'deepseek-flash', inputTokens = 1000, outputTokens = 500, time = Date.UTC(2026, 0, 5, 3, 0, 0) } = {}) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      usage: { inputTokens, outputTokens },
      message: { id: `m-${turn}-${step}`, source: { kind: 'model', provider: 'deepseek-account', model } },
    },
  }
}

/** 一个假 agent：只记下"被取消了"和"被喂了什么"。 */
function fakeAgent(id) {
  return {
    id,
    status: 'running',
    session: { id },
    cancels: [],
    followups: [],
    cancel(cause, options) {
      this.status = 'idle'
      this.cancels.push({ cause, options })
    },
    followup(message) {
      this.followups.push(message)
    },
  }
}

test('花费预警：注册会话投影，把金额与拦截状态同步给浏览器', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    assert.equal(host.projections.length, 1, '必须注册且只注册一个投影')
    const [unit] = host.projections
    assert.equal(unit.key, 'optimizerCostGuard', '投影键带插件前缀，不和别人撞')
    assert.equal(typeof unit.wire.view, 'function')
    assert.deepEqual(unit.wire.view(unit.init()), {
      enabled: false,
      nanos: 0,
      unpricedTokens: 0,
      limit: 0,
      guard: 'clear',
      hits: 0,
    }, '默认关闭、0 元、没拦过')

    const session = { id: 's-1' }
    // 真会话上才认得出来：预值是"这个会话"的，宿主靠 agents 服务把 id 换成会话对象。
    host.agents.set('s-1', fakeAgent('s-1'))
    await host.post({ costGuard: true, costLimit: 0.01 }, host.withSession('s-1'))
    host.emit(session, usageEvent())
    const view = unit.wire.view(unit.apply(unit.init(), { type: 'assistant/message', session }))
    assert.equal(view.nanos, 6_000_000, '折出来的金额要和弹窗显示的一致')
    assert.equal(view.limit, 10_000_000, '预值也下发纳元，界面自己换算成元')
    assert.equal(view.guard, 'clear', '0.006 < 0.01，还没到')
    assert.equal(view.enabled, true)
  })
})

test('花费预警：到预值就停下这一轮，并只拦一次', async () => {
  await withTempHome(async () => {
    const agent = fakeAgent('s-guard')
    const host = fakeHost({ agents: new Map([['s-guard', agent]]) })
    apply(host.ctx, { log: false })
    const session = agent.session

    // 预值 0.005 元 = 5,000,000 纳元，一笔 6,000,000 纳元就过线
    await host.post({ costGuard: true, costLimit: 0.005 }, host.withSession('s-guard'))
    host.emit(session, usageEvent())
    assert.equal(agent.cancels.length, 1, '越线立刻停这一轮')
    assert.deepEqual(agent.cancels[0].cause, { kind: 'hook', reason: 'optimizer:cost-guard' })
    assert.equal(agent.cancels[0].options, undefined, '不能带 keepInbox：队列里的活儿也要停')

    // 后续事件不该再喊一次取消（agent 已经是 idle 了）
    host.emit(session, { type: 'step/end', time: Date.now(), data: { turn: 1, step: 1 } })
    assert.equal(agent.cancels.length, 1, '同一个会话不重复拦')

    // 被拦下之后，下一步必须被拒——否则下一条消息会偷偷续跑
    const decision = await host.fire(
      'agent/pre-step',
      { agent, messages: [userMessage('继续')], turn: 2, step: 1 },
      async () => ({ kind: 'enter' }),
    )
    assert.deepEqual(decision, { kind: 'reject' })
  })
})

test('花费预警：开关关着、预值没填、金额没到，都一律不拦', async () => {
  await withTempHome(async () => {
    const cases = [
      // 注意：这里**不能**拿"填个正数预值"来表达"开关关着"——填正数会自动打开开关
      // （见下一条用例），那条路径本身就是要拦的。
      { config: { costGuard: false }, why: '开关关着' },
      { config: { costGuard: true, costLimit: 0 }, why: '预值 0 = 不限' },
      { config: { costGuard: true, costLimit: 100 }, why: '离预值还远' },
    ]
    for (const item of cases) {
      const agent = fakeAgent('s-off')
      const host = fakeHost({ agents: new Map([['s-off', agent]]) })
      apply(host.ctx, { log: false })
      await host.post(item.config, host.withSession('s-off'))
      host.emit(agent.session, usageEvent())
      assert.equal(agent.cancels.length, 0, `${item.why} 时不该拦`)
      const decision = await host.fire(
        'agent/pre-step',
        { agent, messages: [userMessage('继续')], turn: 2, step: 1 },
        async () => ({ kind: 'enter' }),
      )
      assert.deepEqual(decision, { kind: 'enter' }, `${item.why} 时不该拒绝下一步`)
    }
  })
})

test('花费预警：填一个正数预值会自动打开开关（填 0 不会）', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    assert.equal((await host.read()).costGuard, false, '默认关着')

    const agent = fakeAgent('s-limit')
    const host2 = fakeHost({ agents: new Map([['s-limit', agent]]) })
    apply(host2.ctx, { log: false })
    const [, set] = await host2.post({ costLimit: 0.0001 }, host2.withSession('s-limit'))
    assert.equal(set.costGuard, true, '填正数＝你就是想让它拦，开关要跟着开')
    assert.equal(set.costLimit, 0.0001, '界面拿回的是元，不是纳元')

    // 填 0 表达的是"别拦"：不许把开关又点开
    const [offStatus, off] = await host2.post({ costGuard: false, costLimit: 0 }, host2.withSession('s-limit'))
    assert.equal(offStatus, 200)
    assert.equal(off.costGuard, false)
    assert.equal(off.costLimit, 0)
    const [againStatus, again] = await host2.post({ costLimit: 0 }, host2.withSession('s-limit'))
    assert.equal(againStatus, 200)
    assert.equal(again.costGuard, false, '填 0 不该顺手把开关打开')

    // 不带会话就拒掉：绝不回退成"写一个全局值"（那会拦到别的会话头上）
    const [noSession] = await host2.post({ costLimit: 1 })
    assert.equal(noSession, 400, '不知道写给哪个会话就必须拒绝')
  })
})

test('花费预警：查询串认会话，认不出就 400（不能把状态记到别的会话头上）', async () => {
  await withTempHome(async () => {
    const agent = fakeAgent('s-ask')
    const host = fakeHost({ agents: new Map([['s-ask', agent]]) })
    apply(host.ctx, { log: false })
    await host.post({ costGuard: true, costLimit: 0.005 }, host.withSession('s-ask'))
    host.emit(agent.session, usageEvent())
    await host.fire('agent/pre-step', { agent, messages: [userMessage('把插件写完')], turn: 1, step: 1 }, async () => ({ kind: 'enter' }))

    const [status, body] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=s-ask`)
    assert.equal(status, 200)
    assert.equal(body.guard.guard, 'tripped')
    assert.equal(body.guard.nanos, 6_000_000)
    assert.equal(body.prompt, '把插件写完', '弹窗要能显示本会话最初的提示词')

    // 认不出的会话 id：明确报错，别回一份空状态让界面以为"没在拦"
    const [badStatus, badBody] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=nope`)
    assert.equal(badStatus, 200, '读状态本身是成功的')
    assert.equal(badBody.guard, undefined, '但不会编一个会话出来')
  })
})

test('花费预警：验证通过 → 唤醒；终止 → 只停手并回显最初的提示词（不下发任何指令）', async () => {
  await withTempHome(async () => {
    const agent = fakeAgent('s-cmd')
    const host = fakeHost({ agents: new Map([['s-cmd', agent]]) })
    apply(host.ctx, { log: false })
    await host.post({ costGuard: true, costLimit: 0.005 }, host.withSession('s-cmd'))
    host.emit(agent.session, usageEvent())
    await host.fire('agent/pre-step', { agent, messages: [userMessage('重写鉴权模块')], turn: 1, step: 1 }, async () => ({ kind: 'enter' }))

    const [status, body] = await host.post({ guardAction: 'continue', sessionId: 's-cmd' })
    assert.equal(status, 200)
    assert.equal(body.delivered, true)
    assert.equal(agent.followups.length, 1, '要继续就得给模型一条消息')
    const followup = agent.followups[0]
    assert.equal(followup.role, 'user')
    assert.equal(followup.source.kind, 'optimizer')
    assert.match(followup.content[0].text, /继续这个会话原来那件事/)
    assert.equal(typeof followup.id, 'string')
    assert.equal(followup.reasoningEffort, undefined, '推理等级由会话自己保持，插件不许改')

    // 终止：只停手 + 回显最初的提示词。**一条指令都不下**——尤其不下"删除本会话产出的内容"。
    agent.status = 'running'
    const beforeCount = agent.followups.length
    const [endStatus, endBody] = await host.post({ guardAction: 'terminate', sessionId: 's-cmd' })
    assert.equal(endStatus, 200)
    assert.equal(endBody.terminated, true)
    assert.equal(endBody.prompt, '重写鉴权模块', '终止那一屏要回显最初的提示词')
    assert.equal(agent.followups.length, beforeCount, '终止不许再给模型下任何消息')
    assert.doesNotMatch(JSON.stringify(endBody), /删除|delete/i, '响应里也不该有"删除"这回事')
    assert.equal(agent.cancels.at(-1).options.keepInbox, true, '终止只停手：队列里的活儿保留')
    assert.equal(agent.cancels.at(-1).cause.reason, 'optimizer:cost-guard-terminate')


    const [, after] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=s-cmd`)
    assert.equal(after.guard.guard, 'terminated')
    const decision = await host.fire(
      'agent/pre-step',
      { agent, messages: [userMessage('再改一处')], turn: 2, step: 1 },
      async () => ({ kind: 'enter' }),
    )
    assert.deepEqual(decision, { kind: 'reject' }, '终止之后不许再跑：否则"终止"等于没终止')

    // 解除口是"把额度调宽"（用户在面板里改预值）：改完就该能继续
    await host.post({ costLimit: 1 }, host.withSession('s-cmd'))
    assert.deepEqual(
      await host.fire('agent/pre-step', { agent, messages: [userMessage('继续')], turn: 3, step: 1 }, async () => ({ kind: 'enter' })),
      { kind: 'enter' },
      '调宽额度之后解除停止',
    )
  })
})

test('花费预警：没有活着的 agent 时不能假装成功', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const session = { id: 's-gone' }
    await host.post({ costGuard: true, costLimit: 0.005 }, host.withSession('s-gone'))
    host.emit(session, usageEvent())
    // 会话只在我们自己的记录里（agents 里没有），所以只发一条"继续"是发不出去的
    const [status, body] = await host.post({ guardAction: 'continue', sessionId: 's-gone' })
    assert.equal(status, 200)
    assert.equal(body.delivered, false)
    assert.equal(body.why, 'no-agent')
  })
})

test('花费预警：把预值改大就自己松开，不用额外的"取消拦截"接口', async () => {
  await withTempHome(async () => {
    const agent = fakeAgent('s-raise')
    const host = fakeHost({ agents: new Map([['s-raise', agent]]) })
    apply(host.ctx, { log: false })
    await host.post({ costGuard: true, costLimit: 0.005 }, host.withSession('s-raise'))
    host.emit(agent.session, usageEvent())
    assert.equal(agent.cancels.length, 1)

    const [, body] = await host.post({ costLimit: 10 }, host.withSession('s-raise'))
    assert.equal(body.costLimit, 10)
    const decision = await host.fire(
      'agent/pre-step',
      { agent, messages: [userMessage('继续做')], turn: 2, step: 1 },
      async () => ({ kind: 'enter' }),
    )
    assert.deepEqual(decision, { kind: 'enter' }, '预值改大后就不该再拒')
  })
})

test('花费预警：预值非法直接 400，不当成 0 悄悄放行', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const [status, body] = await host.post({ costLimit: 'abc' }, host.withSession('s-1'))
    assert.equal(status, 400)
    assert.equal(body.error, 'invalid-limit')
    const [status2] = await host.post({ guardAction: 'nonsense', sessionId: 's-1' })
    assert.equal(status2, 400, '不认识的答复要被拒绝')
    const [status3] = await host.post({ guardAction: 'continue' })
    assert.equal(status3, 400, '没说是哪个会话就不答复')
    assert.equal((await host.read()).costLimit, 0, '失败的写入不能偷偷改到盘上的值')
  })
})

test('花费预警：开关与预值写进同一个状态文件，和另两个开关互不覆盖', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    await host.post({ costGuard: true, costLimit: 1.5 }, host.withSession('s-file'))
    await host.post({ enabled: true })
    await host.post({ auto: false })
    const saved = JSON.parse(await readFile(join(home, 'optimizer.json'), 'utf8'))
    assert.deepEqual(saved, { costGuard: true, concise: true, auto: false }, '预值按会话存在内存里，不落盘')
  })
})

test('花费预警：预值按会话独立，互不干扰、各自累加', async () => {
  await withTempHome(async () => {
    const host = fakeHost({
      agents: new Map([
        ['sess-A', fakeAgent('sess-A')],
        ['sess-B', fakeAgent('sess-B')],
      ]),
    })
    apply(host.ctx, { log: false })
    const A = host.agents.get('sess-A')
    const B = host.agents.get('sess-B')

    await host.post({ costLimit: 0.0001 }, host.withSession('sess-A'))
    await host.post({ costLimit: 0.01 }, host.withSession('sess-B'))
    assert.equal((await host.read(host.withSession('sess-A'))).costLimit, 0.0001)
    assert.equal((await host.read(host.withSession('sess-B'))).costLimit, 0.01, '两个会话各记各的')
    assert.equal((await host.read()).costLimit, 0, '不带会话就没有预值可谈')

    // A 花 0.00002：离它自己的预值还差得远
    host.emit(A.session, usageEvent({ inputTokens: 10, outputTokens: 0 }))
    assert.equal(A.cancels.length, 0)
    // B 同样花 0.00002：对 B 的 0.01 来说更不算什么
    host.emit(B.session, usageEvent({ inputTokens: 10, outputTokens: 0 }))
    assert.equal(B.cancels.length, 0, 'B 不该被 A 的小额度影响')

    // A 再花一笔，累计越过它自己的 0.0001 → 只拦 A
    host.emit(A.session, usageEvent({ inputTokens: 50, outputTokens: 0 }))
    assert.equal(A.cancels.length, 1, 'A 到了自己的预值')
    assert.equal(B.cancels.length, 0, 'B 一点都不该动')

    const [, viewA] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=sess-A`)
    const [, viewB] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=sess-B`)
    assert.equal(viewA.guard.guard, 'tripped')
    assert.equal(viewA.guard.limit, 100_000, 'A 的预值')
    assert.equal(viewA.guard.nanos, 120_000, 'A 的累计金额')
    assert.equal(viewB.guard.guard, 'clear', 'B 完全没被拦')
    assert.equal(viewB.guard.limit, 10_000_000, 'B 的预值')
  })
})

test('花费预警：同一场会话、不同的 Session 实例，仍算同一场（按会话 id 记）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ agents: new Map([['s-id', fakeAgent('s-id')]]) })
    apply(host.ctx, { log: false })
    const agent = host.agents.get('s-id')
    await host.post({ costLimit: 0.0001 }, host.withSession('s-id'))

    // 真实宿主在不同回调里给的是**不同对象、同一串 id**：早先按对象当键，预值写在
    // 一个实例上、判定时从另一个实例读，读到"没设"——表现就是"填了预值却不拦"。
    const first = { id: 's-id' }
    const second = { id: 's-id' }
    host.emit(first, usageEvent({ inputTokens: 10, outputTokens: 0 }))
    host.emit(second, usageEvent({ inputTokens: 50, outputTokens: 0 }))
    assert.equal(agent.cancels.length, 1, '两笔要累加到同一场会话上，并越过预值')

    // 弹窗（投影）拿到的也是"另一个实例"，仍要认得出来
    const [, view] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=s-id`)
    assert.equal(view.guard.nanos, 120_000, '按 id 累加，不按对象分家')
    assert.equal(view.guard.limit, 100_000)

    // 没带会话的写入必须被拒：绝不回退成"写一个全局值"
    const [noSession] = await host.post({ costLimit: 5 })
    assert.equal(noSession, 400)
    assert.equal((await host.read(host.withSession('s-id'))).costLimit, 0.0001, '被拒的写入不该动到已有预值')
  })
})

test('花费预警：子代理/无 agent 的会话也要能填预值并真的拦（预值只认会话 id）', async () => {
  await withTempHome(async () => {
    // agents 里**没有**这场会话：子代理会话、已归档会话、宿主刚重启都是这个样子。
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const subagent = { id: 'sub-1' }

    // 1) 填预值：不该因为"查不到 agent"就被拒
    const [status, body] = await host.post({ costLimit: 0.0001 }, host.withSession('sub-1'))
    assert.equal(status, 200, '预值只要会话 id，不需要有活着的 agent')
    assert.equal(body.costGuard, true, '填正数会打开开关')
    assert.equal(body.costLimit, 0.0001, '读回本会话的预值')

    // 2) 到预值仍然要拦得住：这一路不依赖 agent
    host.emit(subagent, usageEvent({ inputTokens: 100, outputTokens: 0 }))
    const decision = await host.fire(
      'agent/pre-step',
      { agent: { session: subagent }, messages: [userMessage('继续')], turn: 1, step: 1 },
      async () => ({ kind: 'enter' }),
    )
    assert.deepEqual(decision, { kind: 'reject' }, '没有 agent 也要按预值拦下下一步')

    // 3) 弹窗读得到金额、预值、最初的提示词
    const [, view] = await host.request('GET', `${ROUTE_PATH}?guard=1&sessionId=sub-1`)
    assert.equal(view.guard.guard, 'tripped')
    assert.equal(view.guard.limit, 100_000, '预值按纳元下发')
    assert.equal(view.guard.nanos, 200_000, '一笔 0.0002 元')
    assert.equal((await host.read(host.withSession('sub-1'))).costLimit, 0.0001)
  })
})

test('花费预警：三个出口都要真的走得通（继续＝放行一步，之后重新拦；调宽＝松开；终止＝停手）', async () => {
  await withTempHome(async () => {
    const agent = fakeAgent('s-exit')
    const host = fakeHost({ agents: new Map([['s-exit', agent]]) })
    apply(host.ctx, { log: false })
    const spend = (nanos) => host.emit(agent.session, usageEvent({ inputTokens: Math.round(nanos / 2000), outputTokens: 0 }))
    const next = () => host.fire(
      'agent/pre-step',
      { agent, messages: [userMessage('继续')], turn: 1, step: 1 },
      async () => ({ kind: 'enter' }),
    )

    await host.post({ costLimit: 0.0001 }, host.withSession('s-exit'))
    host.emit(agent.session, usageEvent({ inputTokens: 60, outputTokens: 0 }))   // 0.00012 元 > 0.0001
    assert.deepEqual(await next(), { kind: 'reject' }, '先被拦')

    // 出口一：填验证码继续 —— 这一步必须真的放行（曾经验证完又被拒回去，看着像"点了没反应"）
    const [, woke] = await host.post({ guardAction: 'continue', sessionId: 's-exit' })
    assert.equal(woke.delivered, true)
    assert.deepEqual(await next(), { kind: 'enter' }, '验证通过后这一步要放行（放行只对一步有效）')

    // 再花一笔还是超 → 重新拦（不是"永久解除"）
    host.emit(agent.session, usageEvent({ inputTokens: 80, outputTokens: 0 }))
    assert.deepEqual(await next(), { kind: 'reject' }, '又超了就要重新拦')

    // 出口二：把预值调宽 → 立刻松开
    const current = (await host.read(`${ROUTE_PATH}?guard=1&sessionId=s-exit`)).guard.nanos
    await host.post({ costLimit: String((current * 2) / 1e9) }, host.withSession('s-exit'))
    assert.equal((await host.read(`${ROUTE_PATH}?guard=1&sessionId=s-exit`)).guard.guard, 'clear', '宽了就松开')
    assert.deepEqual(await next(), { kind: 'enter' })

    // 出口三：终止 → 停手，而且之后不再拦这个会话
    host.emit(agent.session, usageEvent({ inputTokens: 500, outputTokens: 0 }))
    assert.deepEqual(await next(), { kind: 'reject' }, '又超了')
    agent.status = 'running'
    const before = agent.followups.length     // 「继续」已经下发过一条，终止不该再多任何一条
    const [, ended] = await host.post({ guardAction: 'terminate', sessionId: 's-exit' })
    assert.equal(ended.terminated, true)
    assert.equal(agent.followups.length, before, '终止不下发任何消息')
    assert.deepEqual(await next(), { kind: 'reject' }, '终止之后不许再跑')

    // 关掉开关也是解除口（用户明确表示不要这个预警了）
    await host.post({ costGuard: false })
    assert.deepEqual(await next(), { kind: 'enter' }, '关掉开关之后解除停止')
  })
})

test('花费预警：自检端点给出"现在被拦会是什么样"，且不改任何状态', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ agents: new Map([['s-self', fakeAgent('s-self')]]) })
    apply(host.ctx, { log: false })
    const agent = host.agents.get('s-self')
    await host.post({ costLimit: 0.01 }, host.withSession('s-self'))
    host.emit(agent.session, usageEvent({ inputTokens: 100, outputTokens: 0 }))   // 0.0002 元，没到 0.01

    const before = (await host.read(`${ROUTE_PATH}?guard=1&sessionId=s-self`)).guard
    assert.equal(before.guard, 'clear', '先确认它没被拦')

    const [, self] = await host.request('GET', `${ROUTE_PATH}?selftest=1&sessionId=s-self`)
    assert.equal(self.preview.preview, true, '预览要自带标记')
    assert.equal(self.preview.guard, 'tripped', '预览按"被拦"的样子给数据')
    assert.equal(self.preview.limit, 10_000_000, '预值照实给')
    assert.ok(self.preview.nanos > self.preview.limit, '预览金额要越线，界面上才画得出完整弹窗')

    // 自检**不许**改状态：还是没被拦、也不该取消 agent
    const after = (await host.read(`${ROUTE_PATH}?guard=1&sessionId=s-self`)).guard
    assert.equal(after.guard, 'clear', '自检不许把会话标成被拦')
    assert.equal(agent.cancels.length, 0, '自检不许去停 agent')
    assert.deepEqual(await host.fire('agent/pre-step', { agent, messages: [userMessage('继续')], turn: 2, step: 1 }, async () => ({ kind: 'enter' })), { kind: 'enter' })
  })
})
