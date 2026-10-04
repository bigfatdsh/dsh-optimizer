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
  const services = {}
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
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  }
  const route = () => routes.find((entry) => entry.path === ROUTE_PATH)
  const read = async () => {
    const out = []
    await route().handler({ method: 'GET', url: ROUTE_PATH }, { writeHead() {}, end(b) { out.push(JSON.parse(b.toString('utf8'))) } })
    return out[out.length - 1]
  }
  const post = async (body) => {
    const request = (async function* chunks() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    })()
    request.method = 'POST'
    request.url = ROUTE_PATH
    const out = []
    await route().handler(request, { writeHead(status) { out.push(status) }, end(payload) { out.push(JSON.parse(payload.toString('utf8'))) } })
    return out
  }
  return { ctx, sections, routes, logs, route, read, post }
}

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
    assert.equal(initial.switches.length, 1)
    assert.deepEqual(initial.switches[0], {
      id: 'concise',
      label: { zh: '精简化输出', en: 'Concise output' },
      hint: initial.switches[0].hint,
      endpoint: ROUTE_PATH,
      field: 'enabled',
    })
    assert.equal(initial.config.section, SECTION_NAME)

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
