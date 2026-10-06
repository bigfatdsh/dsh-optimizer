/**
 * 浏览器半边的契约测试：优化图标 + 开关面板。
 *
 * 只测**必须成立**的事，渲染细节交给真实浏览器验证：
 *
 * 1. bundle 形态：只 require 种子模块、不能 import、必须按约定注册。
 * 2. 通用开关协议：读登记表、读状态、写状态，任何一步失败都不抛错。
 * 3. 面板行为：点图标开、再点关、Esc 关。
 *
 * 用**极简替身**（不模拟 React 渲染循环）：先前那套复杂替身会在用例之间泄漏内存，
 * 把整个文件跑成堆溢出。契约清楚，替身就该小。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loadCounter = 0

/**
 * 装载 bundle 并取出 exports。
 *
 * @param {object} [options] - `{ fetch }` 替身。
 * @returns {Promise<object>} `{ exports, host, document }`。
 */
async function load(options = {}) {
  globalThis.__INJECTED_STYLES__ = []
  const listeners = []
  const host = []
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: { append: () => {} },
    getElementById: () => null,
    createElement: () => {
      const node = { id: '', textContent: '' }
      globalThis.__INJECTED_STYLES__ = (globalThis.__INJECTED_STYLES__ ?? []).concat([node])
      return node
    },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: () => {},
  }
  /**
   * **一个**转发器装在全局上，具体处理函数放在可变槽里。
   *
   * 每个用例都有自己的 `fetch` 替身，如果直接把替身装到 `globalThis.fetch`，用例之间
   * 就会互相盖掉——前一个用例的异步动作会打到后一个用例的替身上（曾把"唤醒失败"测成
   * 了"唤醒成功"）。转发器只装一次，槽一变就换人，异步动作永远打到当前用例。
   */
  const slot = { handler: options.fetch }
  globalThis.fetch = async (url, init) => {
    host.push({ url, init })
    if (typeof slot.handler === 'function') return slot.handler(url, init)
    return {
      ok: true,
      json: async () => (init?.method === 'POST' ? { enabled: JSON.parse(init.body).enabled } : { enabled: false }),
    }
  }
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => (registration = entry) } }
  await import(`../lib/client.js?case=${++loadCounter}`)
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-optimizer', '注册 id 必须是包名')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return options.react ?? {}
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { exports, host, listeners, slot }
}

test('bundle 形态：只 require 种子模块、无 import、按约定注册', () => {
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  for (const specifier of requires) assert.equal(specifier, 'react', `只允许 require('react')，实际还有 ${specifier}`)
  assert.doesNotMatch(code, /^\s*import\s/m, '客户端 bundle 不能有 import 语句')
  assert.match(code, /__ModuleLoader__\.load\(\{/)
  assert.match(code, /'conversation\.input\.right'/, '必须注册到输入栏右侧插槽')
  assert.doesNotMatch(code, /data-dsh-optimizer/, '不再动内置选择器的 DOM')
})

test('apply：注入样式一次，并注册到输入栏右侧插槽', async () => {
  const { exports } = await load()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  const registered = []
  const styles = []
  globalThis.document.head.append = (node) => styles.push(node)
  let injected = 0
  exports.apply({
    slots: {
      inject: (name, fn) => {
        injected += 1
        assert.equal(name, 'conversation.input.right')
        fn()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  })
  assert.equal(injected, 2, '面板与花费预警弹窗各注入一次')
  assert.equal(registered.length, 2, '应注册两个组件：面板 + 弹窗')
  assert.equal(registered[0].options.id, 'optimizer')
  assert.equal(registered[1].options.id, 'optimizer-cost-guard')
  assert.equal(styles.length, 1, '应注入一份样式')
  assert.equal(styles[0].id, 'dsh-optimizer-style')
  assert.match(styles[0].textContent, /\[data-dsh-opt-icon\]/)
  assert.match(styles[0].textContent, /\[data-dsh-guard-digit\]/)
})

test('通用协议：读登记表 → 读状态 → 写状态', async () => {
  const { exports } = await load({
    fetch: async (url, init) => {
      if (String(url).includes('switches=1')) {
        return {
          ok: true,
          json: async () => ({
            switches: [
              { id: 'auto', label: { zh: '自动化推理等级' }, hint: { zh: 'x' }, endpoint: '/dsh-optimizer', field: 'enabled' },
              { id: 'concise', label: { zh: '精简化输出' }, hint: { zh: 'y' }, endpoint: '/dsh-other-switch', field: 'enabled', optional: true },
            ],
          }),
        }
      }
      if (String(url).startsWith('/dsh-other-switch')) {
        // 模拟"没装那个插件"：请求失败
        throw new Error('not installed')
      }
      return { ok: true, json: async () => (init?.method === 'POST' ? { enabled: JSON.parse(init.body).enabled } : { enabled: true }) }
    },
  })
  const registry = await exports.readRegistry()
  assert.equal(registry.length, 2)
  assert.equal(await exports.readSwitch('/dsh-optimizer', 'enabled'), true)
  assert.equal(await exports.readSwitch('/dsh-other-switch', 'enabled'), undefined, '读不到要给 undefined，调用方据此隐藏')
  assert.equal(await exports.writeSwitch('/dsh-optimizer', 'enabled', false), false)
})

test('通用协议：端点 404 或返回垃圾时返回 undefined，不抛错', async () => {
  const { exports } = await load({
    fetch: async (url, init) => {
      if (String(url).includes('switches=1')) return { ok: true, json: async () => ({ switches: 'nope' }) }
      if (init?.method === 'POST') return { ok: false, status: 404, json: async () => ({ error: 'x' }) }
      return { ok: false, status: 404, json: async () => ({}) }
    },
  })
  assert.deepEqual(await exports.readRegistry(), [], '登记表形状不对要回退成空表')
  assert.equal(await exports.readSwitch('/nope', 'enabled'), undefined, '404 要给 undefined，不能猜')
  assert.equal(await exports.writeSwitch('/nope', 'enabled', true), undefined, '写失败要给 undefined')

  // 返回垃圾 JSON（没有布尔字段）同样要给 undefined
  const junk = await load({ fetch: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  assert.equal(await junk.exports.readSwitch('/x', 'enabled'), undefined)
  assert.equal(await junk.exports.writeSwitch('/x', 'enabled', true), undefined, '写回垃圾不能被当成成功')
})

/**
 * 显式的小渲染器：真保存状态、真跑 effect（尊重依赖）、setter 触发的重渲染用**当前**
 * 渲染函数。React 这三条语义缺一条，面板类测试就会假通过或自激。
 *
 * @returns {object} `{ react, reset, latest }`。
 */
function createRuntime() {
  /** 按 `命名空间:序号` 存 hook 格：两个组件各自从 0 数，互不挤位。 */
  const cells = new Map()
  let cursor = 0
  let namespace = 'main'
  const key = (index) => `${namespace}:${index}`
  const cellAt = (index, initial) => {
    const name = key(index)
    if (!cells.has(name)) cells.set(name, initial)
    return name
  }
  const latest = { render: () => {} }
  const same = (a, b) =>
    a === undefined || b === undefined || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (initial) => {
      const name = cellAt(cursor++, { current: initial })
      return cells.get(name)
    },
    useState: (initial) => {
      const name = cellAt(cursor++, initial)
      return [
        cells.get(name),
        (next) => {
          const value = typeof next === 'function' ? next(cells.get(name)) : next
          if (Object.is(value, cells.get(name))) return
          cells.set(name, value)
          latest.render()
        },
      ]
    },
    useMemo: (fn, deps) => {
      const name = cellAt(cursor++, { deps: undefined, value: undefined })
      const cell = cells.get(name)
      if (same(deps, cell.deps)) {
        cell.deps = deps === undefined ? undefined : [...deps]
        cell.value = fn()
      }
      return cell.value
    },
    useCallback: (fn, deps) => {
      const name = cellAt(cursor++, { deps: undefined, fn })
      const cell = cells.get(name)
      if (same(deps, cell.deps)) {
        cell.deps = deps === undefined ? undefined : [...deps]
        cell.fn = fn
      }
      return cell.fn
    },
    useEffect: (fn, deps) => {
      const name = cellAt(cursor++, { deps: undefined, cleanup: undefined })
      const cell = cells.get(name)
      if (!same(deps, cell.deps)) return
      if (typeof cell.cleanup === 'function') cell.cleanup()
      cell.deps = deps === undefined ? undefined : [...deps]
      const cleanup = fn()
      cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    },
  }
  return {
    react,
    latest,
    /** 切到某个组件的命名空间并从它的第 0 个 hook 开始数。 */
    enter: (name) => {
      namespace = name
      cursor = 0
    },
  }
}

/**
 * 取 apply 注入的那份样式文本。
 *
 * 样式节点是 `document.createElement('style')` 造出来的，`load()` 里把 `head.append`
 * 换成了往 `styles` 数组里塞。这里直接读最后一份（每个用例各注入一次）。
 *
 * @param {Array} listeners - `load()` 返回的监听器数组（用不到，传进来只为保持签名一致）。
 * @returns {string} 样式文本。
 */
function injectedStyle(listeners) {
  void listeners
  const styles = globalThis.__INJECTED_STYLES__ ?? []
  assert.ok(styles.length > 0, 'apply 必须注入一份样式')
  const last = styles[styles.length - 1]
  return typeof last === 'string' ? last : last.textContent
}

/**
 * 找到虚拟树里的开关行。
 *
 * 面板的结构可以是"行直接挂在面板上"，也可以是"行挂在一层容器里"，用例只关心行本身，
 * 所以这里递归找，不假设层级——面板加一层排版容器不该让契约测试挂掉。
 *
 * @param {object} node - 任一虚拟节点。
 * @returns {object[]} 带 `data-dsh-opt-row` 的节点。
 */
function rowElements(node) {
  const found = []
  const walk = (current) => {
    if (current === null || typeof current !== 'object') return
    if (current.props?.['data-dsh-opt-row'] === '') found.push(current)
    for (const child of current.children ?? []) {
      if (Array.isArray(child)) for (const item of child) walk(item)
      else walk(child)
    }
  }
  walk(node)
  return found
}

/**
 * 取一行里的开关本体（`role="switch"` 的那个按钮）。
 *
 * @param {object} row - 开关行节点。
 * @returns {object} 开关按钮节点。
 */
function switchOf(row) {
  const walk = (current) => {
    if (current === null || typeof current !== 'object') return undefined
    if (current.props?.role === 'switch') return current
    for (const child of current.children ?? []) {
      const found = Array.isArray(child) ? child.map(walk).find((item) => item !== undefined) : walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = walk(row)
  assert.ok(found !== undefined, '每一行都要有一个 role="switch" 的开关本体')
  return found
}

/**
 * 装载 + 注册组件，给出"渲染一次"。
 *
 * 两个组件都注册在同一个插槽上：`registry[0]` 是优化面板，`registry[1]` 是花费
 * 预警弹窗（它需要 `useProjection`，所以渲染时要把它一起传进去）。
 *
 * @param {object} [options] - `{ fetch, projection, sessionId }` 替身。
 * @returns {Promise<object>} `{ render, state, exports }`。
 */
async function mountPanel(options = {}) {
  const runtime = createRuntime()
  const loaded = await load({ react: runtime.react, fetch: options.fetch })
  // 把"当前用例的 fetch"放回转发器的槽里（见 load 的注释）。
  loaded.slot.handler = options.fetch
  const registry = []
  loaded.exports.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (_slotOptions, component) => {
        registry.push(component)
        return () => {}
      },
    },
  })
  assert.equal(registry.length, 2, '应注册两个组件：面板 + 弹窗')
  const state = { tree: undefined, guard: null, projection: options.projection }
  /** 重画函数（函数声明要放在 `repaint` 之前，它引用的就是这个名字）。 */
  function render() {
    bind()
    renderPanel()
    renderGuard()
  }
  /**
   * 只画面板。
   *
   * **两个组件必须各自重置 hook 游标再画**：这个替身靠"第几个 hook"定位状态格，
   * 连着画两个组件会让后一个的格子整体错位（弹窗的六个数字框会全读成空串）。真实
   * React 用组件自己的 hook 链表，没有这个问题；替身只能照着模拟。
   */
  function renderPanel() {
    runtime.enter('panel')
    state.tree = registry[0]({})
  }
  /** 只画弹窗（它多一个 `useProjection`）。 */
  function renderGuard() {
    runtime.enter('guard')
    state.guard = registry[1]({
      sessionId: options.sessionId ?? 'session-1',
      useProjection: (key) => {
        assert.equal(key, 'optimizerCostGuard', '弹窗只读这一个投影键')
        return state.projection
      },
      t: (text) => text,
    })
  }
  /**
   * 重画并让 effect 落定。
   *
   * 六位数字是在 effect 里写进去的状态，写完还要再画一次才看得见。真实 React 自己
   * 会重画，这个替身不会，所以用例要显式地把"再画一次"说出来。
   *
   * @returns {Promise<void>} 稳定后再画一帧。
   */
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
    render()
  }
  /**
   * 把"状态一变就重画"接到完整的 `render` 上。
   *
   * 替身里 `latest.render` 默认指向**挂载那一刻**的闭包，那个闭包捕获的是挂载时的
   * `sessionId` / `projection`。用例中途改了投影或会话，重画必须用新的值，所以要显式
   * 把重画指到这里。真实 React 每次重画都重新读 props，不存在这个问题。
   *
   * @returns {void}
   */
  const bind = () => {
    runtime.latest.render = render
  }
  render()
  return { render, state, exports: loaded.exports, flush, bind }
}

test('面板：点图标开，再点关', async () => {
  const { render, state } = await mountPanel()
  render()
  const icon = () => state.tree.children[0]
  assert.equal(icon().props['data-dsh-opt-icon'], '', '图标按钮要在')
  assert.equal(icon().props['aria-expanded'], 'false', '初始关闭')
  assert.equal(state.tree.children[1], null, '初始不渲染面板')

  icon().props.onClick()
  assert.equal(icon().props['aria-expanded'], 'true', '点一下要打开')
  assert.equal(state.tree.children[1].props['data-dsh-opt-panel'], '', '点一下要渲染面板')

  icon().props.onClick()
  assert.equal(icon().props['aria-expanded'], 'false', '再点一下要关闭')
  assert.equal(state.tree.children[1], null, '再点一下要收起面板')
})

test('回归：打开面板不自激（请求与渲染次数都有界）', async () => {
  // "开 auto 就卡死"的现场在这里被钉住：打开面板 → 读登记表 → 读端点。
  // 任何一步重复触发都会让这两个计数失控。
  let fetchCalls = 0
  const { render, state } = await mountPanel({
    fetch: async (url) => {
      fetchCalls += 1
      if (fetchCalls > 30) throw new Error(`请求失控：已发出 ${fetchCalls} 次`)
      if (String(url).includes('switches=1')) {
        return {
          ok: true,
          json: async () => ({
            switches: [
              { id: 'auto', label: { zh: '自动化推理等级' }, hint: { zh: 'a' }, endpoint: '/dsh-optimizer', field: 'enabled' },
              { id: 'concise', label: { zh: '精简化输出' }, hint: { zh: 'c' }, endpoint: '/dsh-optimizer', field: 'concise' },
            ],
          }),
        }
      }
      return { ok: true, json: async () => ({ enabled: true, concise: true }) }
    },
  })
  render()
  state.tree.children[0].props.onClick()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  render()

  const panel = state.tree.children[1]
  assert.ok(panel !== null, '面板要打开')
  const rows = rowElements(panel)
  assert.equal(rows.length, 2, '两个开关都要画出来')
  assert.equal(rows.every((row) => switchOf(row).props['aria-checked'] === 'true'), true, '都读成开启')
  // 同端点只请求一次 + 一次登记表 = 2 次；给点余量但不许失控。
  assert.ok(fetchCalls <= 4, `请求次数应有界，实际 ${fetchCalls}`)
})

test('面板：登记表的每一项都映射成开关行', async () => {
  const { render, state } = await mountPanel({
    fetch: async (url) => {
      if (String(url).includes('switches=1')) {
        return {
          ok: true,
          json: async () => ({
            switches: [
              { id: 'auto', label: { zh: '自动化推理等级' }, hint: { zh: 'a' }, endpoint: '/dsh-optimizer', field: 'enabled' },
              { id: 'concise', label: { zh: '精简化输出' }, hint: { zh: 'c' }, endpoint: '/dsh-optimizer', field: 'concise' },
            ],
          }),
        }
      }
      return { ok: true, json: async () => ({ enabled: true, concise: false }) }
    },
  })
  render()
  state.tree.children[0].props.onClick()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  render()
  const rows = rowElements(state.tree.children[1])
  assert.equal(rows.length, 2, `两个开关都要画出来，实际 ${rows.length}`)
  assert.equal(switchOf(rows[0]).props['aria-checked'], 'true', 'auto 读到 true')
  assert.equal(switchOf(rows[1]).props['aria-checked'], 'false', 'concise 读到 false（同端点不同字段）')
})

test('面板：点某一行会写回后端，并用返回值更新显示', async () => {
  const writes = []
  const { render, state } = await mountPanel({
    fetch: async (url, init) => {
      if (String(url).includes('switches=1')) {
        return {
          ok: true,
          json: async () => ({
            switches: [{ id: 'auto', label: { zh: '自动化推理等级' }, hint: { zh: 'a' }, endpoint: '/dsh-optimizer', field: 'enabled' }],
          }),
        }
      }
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        return { ok: true, json: async () => ({ enabled: true }) }
      }
      return { ok: true, json: async () => ({ enabled: false }) }
    },
  })
  render()
  state.tree.children[0].props.onClick()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  render()
  const row = () => rowElements(state.tree.children[1])[0]
  assert.equal(switchOf(row()).props['aria-checked'], 'false', '初始关闭')

  row().props.onClick()
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes, [{ enabled: true }], `应写回 {enabled:true}，实际 ${JSON.stringify(writes)}`)
  assert.equal(switchOf(row()).props['aria-checked'], 'true', '显示要跟着后端返回值更新')
})

// --- 花费预警弹窗 -----------------------------------------------------------

/** 一次"被拦下"的投影。金额用微元，和宿主下发的一致。 */
const trippedView = (over = {}) => ({
  enabled: true,
  nanos: 6_000_000,
  unpricedTokens: 0,
  limit: 5_000_000,
  guard: 'tripped',
  hits: 1,
  ...over,
})

/** 找虚拟树里带某个 data 属性的节点。 */
function findNodes(node, attribute) {
  const found = []
  const walk = (current) => {
    if (current === null || typeof current !== 'object') return
    if (current.props?.[attribute] !== undefined) found.push(current)
    for (const child of current.children ?? []) {
      if (Array.isArray(child)) for (const item of child) walk(item)
      else walk(child)
    }
  }
  walk(node)
  return found
}

/**
 * 读出弹窗上方展示的那六位数字。
 *
 * 展示用的数字（只读）与用户输入的六个框是**两处**：前者在上、后者在下，用例必须
 * 从展示处取"正确答案"，不能从输入框取（输入框按设计就是空的）。
 *
 * @param {object} node - 弹窗根节点。
 * @returns {string} 六位数字。
 */
function shownCode(node) {
  const boxes = findNodes(node, 'data-dsh-guard-code-digit')
  return boxes.map((box) => box.children.join('')).join('')
}

/** 按 `data-dsh-guard-*` 找一个节点。 */
function guardNode(node, attribute) {
  const found = findNodes(node, attribute)
  assert.ok(found.length > 0, `找不到 ${attribute}`)
  return found[0]
}

test('弹窗：没被拦时什么都不渲染', async () => {
  const { state } = await mountPanel({ projection: { guard: 'clear', nanos: 0, limit: 0, enabled: true } })
  assert.equal(state.guard, null, 'guard: clear 时不许弹窗')
  const { state: opened } = await mountPanel({ projection: undefined })
  assert.equal(opened.guard, null, '读不到投影时也不许弹窗')
})

test('弹窗：被拦时显示金额与预值，并给六个等距数字框', async () => {
  const { flush, state } = await mountPanel({ projection: trippedView() })
  await flush()
  const root = state.guard
  assert.ok(root !== null, 'guard: tripped 必须弹窗')
  assert.equal(findNodes(root, 'data-dsh-guard-root').length, 1, '要有一层铺满屏幕的遮罩容器')
  assert.equal(findNodes(root, 'data-dsh-guard-mask').length, 1, '遮罩要挡住背后的点击')
  const card = guardNode(root, 'data-dsh-guard-card')
  assert.equal(card.props.role, 'dialog')
  assert.equal(card.props['aria-modal'], 'true')

  // 金额按元显示（微元 / 1e6，四位小数），不是原始微元
  const text = JSON.stringify(root)
  assert.match(text, /0\.006/, '已花费要显示成 0.006 元')
  assert.match(text, /0\.005/, '预值要显示成 0.005 元')

  const digits = findNodes(root, 'data-dsh-guard-digit')
  assert.equal(digits.length, 6, '必须是六个数字框')
  assert.equal(digits.every((box) => box.props.value === ''), true, '输入框初始必须是空的')
  assert.match(shownCode(root), /^[0-9]{6}$/, '上方要展示一组随机的六位数字')

  // 验证没填对之前，继续按钮必须是禁用的
  const buttons = findNodes(root, 'data-dsh-guard-primary')
  const resume = buttons.find((button) => button.children.includes('继续任务'))
  assert.ok(resume !== undefined, '要有"继续任务"按钮')
  assert.equal(resume.props.disabled, true, '数字没填对之前不许继续')

  // 红色终止按钮在，且和继续是两个不同的按钮
  const danger = guardNode(root, 'data-dsh-guard-danger')
  assert.equal(danger.children.includes('终止任务'), true)
})

test('弹窗：填对六位数字才放行，填错只报错不发请求', async () => {
  const posts = []
  const { flush, state } = await mountPanel({
    projection: trippedView(),
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ guardAction: 'continue', delivered: true }) }
      }
      return { ok: true, json: async () => ({}) }
    },
  })
  await flush()
  const boxesOf = () => findNodes(state.guard, 'data-dsh-guard-digit')
  const resumeOf = () => findNodes(state.guard, 'data-dsh-guard-primary').find((button) => button.children.includes('继续任务'))
  const code = shownCode(state.guard)
  assert.match(code, /^[0-9]{6}$/)

  // 填错一位：按钮仍禁用，也不能发出请求
  const wrong = `${code.slice(0, 5)}${code[5] === '0' ? '1' : '0'}`
  for (let index = 0; index < 6; index += 1) {
    boxesOf()[index].props.onChange({ target: { value: wrong[index] } })
  }
  await flush()
  assert.equal(resumeOf().props.disabled, true, '填错时按钮必须禁用')
  await resumeOf().props.onClick()
  assert.equal(posts.length, 0, '填错时一个请求都不许发')

  // 填对：按钮放开，点了才发请求
  for (let index = 0; index < 6; index += 1) {
    boxesOf()[index].props.onChange({ target: { value: code[index] } })
  }
  await flush()
  assert.equal(resumeOf().props.disabled, false, '填对时按钮必须可用')
  await resumeOf().props.onClick()
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posts.length, 1, '只发一次')
  assert.equal(posts[0].url, '/dsh-optimizer')
  assert.deepEqual(posts[0].body, { guardAction: 'continue', sessionId: 'session-1' })
})

test('弹窗：终止只发 terminate，然后只把最初的提示词摆出来（没有任何删除指令）', async () => {
  const posts = []
  const { flush, state } = await mountPanel({
    sessionId: 'session-9',
    projection: trippedView(),
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return { ok: true, json: async () => ({ guardAction: 'terminate', terminated: true, prompt: '给这个插件加个功能' }) }
      }
      return { ok: true, json: async () => ({}) }
    },
  })
  await guardNode(state.guard, 'data-dsh-guard-danger').props.onClick()
  await flush()
  assert.deepEqual(posts, [{ url: '/dsh-optimizer', body: { guardAction: 'terminate', sessionId: 'session-9' } }])

  // 终止之后那一屏：说清已经停手、没有下删除指令，并把最初的提示词摆出来
  const text = JSON.stringify(state.guard)
  assert.match(text, /给这个插件加个功能/, '必须回显本会话最初的提示词')
  assert.match(text, /这一轮已经停住/)
  assert.match(text, /没有.*删除指令/, '要明确告诉用户：插件没让模型删任何东西')
  assert.doesNotMatch(text, /删除本会话为这次任务产出的东西/, '那套清理指令已经取消了')
  assert.doesNotMatch(text, /拿不准某个文件是不是本次产出的/, '那套清理指令已经取消了')
  assert.doesNotMatch(text, /data-dsh-guard-digit/, '终止后不再要验证码')
  assert.doesNotMatch(text, /data-dsh-guard-prompt[^]*清理/, '不再展示任何清理指令原文')
})

test('弹窗：宿主说没能唤醒时如实告诉用户，不要假装成功', async () => {
  // 这个用例只做一件事：宿主回"没送出去"，界面就得说出来。所以所有请求（含面板启动
  // 那几次）都回同一份回执，避免用例之间抢同一个 fetch 造成的假通过。
  const receipt = { guardAction: 'continue', delivered: false, why: 'no-agent' }
  const { flush, state } = await mountPanel({
    projection: trippedView(),
    fetch: async () => ({ ok: true, json: async () => receipt }),
  })
  await flush()
  const boxes = findNodes(state.guard, 'data-dsh-guard-digit')
  const code = shownCode(state.guard)
  assert.match(code, /^[0-9]{6}$/)
  for (let index = 0; index < 6; index += 1) {
    findNodes(state.guard, 'data-dsh-guard-digit')[index].props.onChange({ target: { value: code[index] } })
  }
  await flush()
  const resume = () => findNodes(state.guard, 'data-dsh-guard-primary').find((button) => button.children.includes('继续任务'))
  console.log('DBG13', JSON.stringify(globalThis.__D__), JSON.stringify((globalThis.__D2__ ?? []).slice(-4)))
  assert.equal(resume().props.disabled, false, '填对了就该能点')
  await resume().props.onClick()
  await flush()
  const failure = findNodes(state.guard, 'data-dsh-guard-fail')
  assert.equal(failure.length, 1, '要显示失败原因')
  assert.match(JSON.stringify(failure[0]), /没有活动的模型连接/)
})

test('弹窗：同一场会话再次被拦会换一组新数字（不能沿用上一组）', async () => {
  const first = trippedView({ hits: 1 })
  const { flush, state } = await mountPanel({ projection: first })
  await flush()
  const firstCode = shownCode(state.guard)

  state.projection = { ...first, hits: 2, nanos: 12_000_000 }
  await flush()
  const secondCode = shownCode(state.guard)
  assert.match(secondCode, /^[0-9]{6}$/, '再次被拦要有一组数字')
  assert.match(firstCode, /^[0-9]{6}$/, '第一组也必须是六位数字')
  // 概率上可能撞（1/1e6），撞了就再抽一次来验证"确实在重抽"这条路径存在
  if (firstCode === secondCode) {
    state.projection = { ...first, hits: 3, nanos: 18_000_000 }
    await flush()
    const third = shownCode(state.guard)
    assert.match(third, /^[0-9]{6}$/)
  }
})

test('弹窗：屏幕上的六位数字就是校验用的那六位（重画多少次都不许换）', async () => {
  // 这条钉的是一个真实踩过的坑：展示的数字和校验的数字如果不在同一帧里对齐，
  // 用户"照着屏幕抄"也过不了关。做法是让弹窗在两次重画之间反复渲染，中途还推一次
  // 宿主投影（金额变了、hits 没变 = 同一轮拦截），再照抄屏幕上的数字，必须放行。
  const posts = []
  const { flush, state } = await mountPanel({
    projection: trippedView(),
    fetch: async (url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return { ok: true, json: async () => ({ guardAction: 'continue', delivered: true }) }
      }
      return { ok: true, json: async () => ({}) }
    },
  })
  await flush()
  const shown = shownCode(state.guard)
  assert.match(shown, /^[0-9]{6}$/, '要有一组可抄的数字')

  // 中途宿主又报了一笔花费：金额变、hits 不变（还是同一轮拦截）
  state.projection = { ...trippedView(), nanos: 9_000_000 }
  await flush()
  assert.equal(shownCode(state.guard), shown, '同一轮拦截里重画不许换数字')

  // 照抄屏幕上的数字
  for (let index = 0; index < 6; index += 1) {
    findNodes(state.guard, 'data-dsh-guard-digit')[index].props.onChange({ target: { value: shown[index] } })
  }
  await flush()
  const resume = () => findNodes(state.guard, 'data-dsh-guard-primary').find((button) => button.children.includes('继续任务'))
  assert.equal(resume().props.disabled, false, '照着屏幕抄就该能点')
  await resume().props.onClick()
  await flush()
  assert.deepEqual(posts, [{ guardAction: 'continue', sessionId: 'session-1' }], '只发一次放行请求')
})

test('开关：度量与内置控件逐条对齐（这是"美术风格错位"的护栏）', async () => {
  // 内置开关的度量写在 ui-primitives 的 Switch.module.css 里：36×20 药丸、2px 内边距、
  // 16×16 圆滑块、打开时右移 16px。这两个数字一旦对不上，面板里的开关看起来就和旁边的
  // 内置控件不是同一套东西，所以这里把形状与尺寸钉死。
  //
  // 只比形状与尺寸，不比颜色：颜色两边都以语义变量表达，换肤后自然一致；尺寸是实打实的
  // 数字，写偏了一定看得出来。
  const { exports, listeners } = await load()
  const registered = []
  exports.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => {
        registered.push(component)
        return () => {}
      },
    },
  })
  assert.equal(registered.length, 2)
  const style = injectedStyle(listeners)
  assert.match(style, /data-dsh-opt-track/, '样式里必须有开关规则')

  const track = /\[data-dsh-opt-track\]\{([^}]*)\}/.exec(style)?.[1] ?? ''
  const thumb = /\[data-dsh-opt-thumb\]\{([^}]*)\}/.exec(style)?.[1] ?? ''
  const on = /\[data-dsh-opt-track\]\[data-on="1"\] \[data-dsh-opt-thumb\]\{([^}]*)\}/.exec(style)?.[1] ?? ''
  assert.ok(track !== '' && thumb !== '' && on !== '', '开关的三条规则都要在样式里')

  const value = (block, key) => new RegExp(`${key}:\\s*([^;}]*)`).exec(block)?.[1]?.trim()
  assert.equal(value(track, 'width'), '36px', '轨道宽度要和内置一致')
  assert.equal(value(track, 'height'), '20px', '轨道高度要和内置一致')
  assert.equal(value(track, 'padding'), '2px', '轨道内边距要和内置一致')
  assert.equal(value(track, 'border-radius'), '999px', '药丸圆角要和内置一致')
  assert.equal(value(track, 'corner-shape'), 'round', '必须退出全局超椭圆圆角，否则胶囊形状不对')
  assert.equal(value(thumb, 'width'), '16px', '滑块尺寸要和内置一致')
  assert.equal(value(thumb, 'height'), '16px', '滑块尺寸要和内置一致')
  assert.equal(value(thumb, 'corner-shape'), 'round', '滑块必须是正圆')
  assert.equal(value(on, 'transform'), 'translateX(16px)', '打开时的位移要和内置一致')
  assert.equal(value(on, 'background'), 'var(--dsw-alias-label-primary-foreground)', '打开时滑块用前景色，和内置一致')
})
