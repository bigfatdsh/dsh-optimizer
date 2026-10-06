/**
 * dsh-optimizer —— 浏览器半边：**优化图标 + 开关面板 + 花费预警弹窗**。
 *
 * ## 位置
 *
 * `conversation.input.right`（模型选择器左边）一个图标按钮，点开是和模型列表同风格的
 * 弹层，里面是**一排开关**。上一版把"选中的 Auto"写进内置模型选择器的触发器，那条路
 * 依赖内置组件的 DOM 与内部状态，宿主一改就断，而且没法和别的开关放在一起。
 *
 * ## 开关是登记出来的，不是写死的
 *
 * 面板从宿主读一张登记表（`GET <本插件端点>?switches=1`），表里每项描述一个开关：
 * `{ id, label, hint, endpoint, field, input? }`。任何插件只要实现同一个约定就能进来：
 *
 *   * `GET  <endpoint>` → `{ "<field>": boolean }`
 *   * `POST <endpoint>` body `{ "<field>": boolean }` → `{ "<field>": boolean }`
 *
 * `input` 是可选的一格数字框：`{ field, unit, placeholder, hint }`。花费预警就是
 * 靠它把"预值填多少"长在标题后面，而不是另开一块设置页。
 *
 * ## 弹窗为什么由投影驱动
 *
 * `useProjection('optimizerCostGuard')` 是会话作用域 slot 自带的标准 hook。宿主那边
 * 判定拦截、算出金额，浏览器这边**只显示不判断**：`guard === 'tripped'` 就弹窗，
 * 所以多个标签页看到的是同一件事，刷新也不会漏掉已经发生的拦截。
 *
 * ## 约束（踩过的坑，别改）
 *
 * 只 `require('react')` 这一个启动期种子模块；不能 `import`、不能 require 自己包的
 * 子路径——客户端组合会整体失败，应用直接打不开。所以弹窗、数字框、样式全部手写。
 *
 * @module dsh-optimizer/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-optimizer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 本插件在宿主侧的端点：开关登记表与自身状态都从这里读写。 */
    const ENDPOINT = '/dsh-optimizer'

    const STYLE_ID = 'dsh-optimizer-style'

    /** 拦截弹窗要验证的位数。**六位**：随机数，不是用户设的。 */
    const CODE_LENGTH = 6

    const zh = {
      title: '优化',
      close: '关闭',
      loading: '读取中…',
      failed: '读不到状态，请稍后重试',
      empty: '当前没有可用的开关',
      askTitle: '花费预警',
      askLead: '本会话花费已达到你设的预值，任务已停在这里。',
      spent: '已花费',
      limit: '预值',
      unpriced: '其中未计价 token',
      verifyLead: '要继续这个会话，请照着输入下面这六位数字：',
      verifyLabel: '验证数字',
      inputLabel: '验证码第 %d 位',
      inputHint: '按顺序输入上面六位数字。',
      mismatch: '数字不对，请照上面的六位重新输入。',
      continueAction: '继续任务',
      continuing: '正在唤醒…',
      continueFailed: '已放行，但没能自动唤醒：请在输入框里发一句话，任务会接着做。',
      terminate: '终止任务',
      terminating: '正在终止…',
      endTitle: '任务已停止',
      endStopped: '这一轮已经停住，不会再往下做。插件**没有**给模型下任何删除指令——本会话产出的东西怎么处理，由你自己决定。',
      originalPrompt: '本会话最初的提示词',
      noPrompt: '（没有记录到最初的提示词）',
      keepClosed: '关闭这个窗口',
      keepClosedHint: '关闭只是收起这个窗口，不会删任何文件；要继续这个会话，直接在下一条消息里说。',
      notEnough: '这个会话当前没有活动的模型连接，继续不了。请在输入框里发一句话，任务会接着做。',
    }
    const en = {
      title: 'Optimize',
      close: 'Close',
      loading: 'Loading…',
      failed: 'Could not read state, try again',
      empty: 'No switches available',
      askTitle: 'Cost warning',
      askLead: 'This session reached the limit you set. The task stopped here.',
      spent: 'Spent',
      limit: 'Limit',
      unpriced: 'tokens without a price',
      verifyLead: 'To continue this session, type the six digits below:',
      verifyLabel: 'Verification digits',
      inputLabel: 'Verification digit %d',
      inputHint: 'Type the six digits above in order.',
      mismatch: 'Those digits do not match. Type the six above again.',
      continueAction: 'Continue task',
      continuing: 'Waking up…',
      continueFailed: 'Released, but the task could not be woken automatically: send any message in the composer and it will pick up where it stopped.',
      terminate: 'Terminate task',
      terminating: 'Terminating…',
      endTitle: 'Task stopped',
      endStopped: 'This turn is stopped and will not continue. The plugin sent the model no delete instruction: what this session produced is yours to decide.',
      originalPrompt: 'The first prompt of this session',
      noPrompt: '(no first prompt was recorded)',
      keepClosed: 'Close this window',
      keepClosedHint: 'Closing only dismisses this window; nothing is deleted. To carry on with this session, just send your next message.',
      notEnough: 'This session has no live model connection, so it cannot continue on its own. Send any message in the composer and the task will pick up.',
    }

    /**
     * 样式：位置、尺寸、配色都对齐内置控件。
     *
     * 图标按钮与模型选择器的 trigger 同高（28px）、同圆角、同 hover 底色；弹层与弹窗
     * 用 `--dsw-alias-bg-layer-*` / `--dsw-elevation-prominent` 之类的语义变量，
     * 深浅色主题都自动跟随。**不写死任何颜色**，否则换肤就露出来。
     */
    const style = `
[data-dsh-opt-root]{position:relative;display:inline-flex;align-items:center}
[data-dsh-opt-icon]{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:28px;min-width:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;
  line-height:20px;cursor:pointer}
[data-dsh-opt-icon]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-opt-icon][data-on="1"]{color:var(--dsw-alias-brand-primary)}
[data-dsh-opt-icon]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-dsh-opt-panel]{position:absolute;bottom:calc(100% + 8px);right:0;z-index:60;box-sizing:border-box;
  width:368px;max-width:calc(100vw - 32px);padding:6px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-module-platform);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-primary)}
[data-dsh-opt-head]{display:flex;align-items:center;justify-content:space-between;
  padding:4px 8px 8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px}
[data-dsh-opt-close]{display:inline-flex;align-items:center;justify-content:center;
  height:20px;min-width:20px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;
  line-height:18px;cursor:pointer}
[data-dsh-opt-close]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-opt-close]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
[data-dsh-opt-row]{display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:52px;padding:8px;border-radius:var(--dsw-radius-sm);cursor:pointer}
[data-dsh-opt-row]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-opt-row]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
[data-dsh-opt-text]{display:flex;flex-direction:column;gap:2px;min-width:0}
[data-dsh-opt-main]{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
[data-dsh-opt-label]{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
[data-dsh-opt-hint]{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
[data-dsh-opt-tail]{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto}
[data-dsh-opt-amount]:not([hidden]){display:inline-flex;align-items:center;gap:4px}
/* 数字框用内置输入框那一套语义变量与度量（0.5px 描边 + radius-sm + layer-1 底色），
   尺寸按行内高度收一档，和左边的标题同一行也对得齐。 */
[data-dsh-opt-amount] input{box-sizing:border-box;width:72px;height:26px;margin:0;padding:0 6px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:18px;text-align:right;font-variant-numeric:tabular-nums}
[data-dsh-opt-amount] input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
[data-dsh-opt-amount] input::placeholder{color:var(--dsw-alias-label-dimmed)}
[data-dsh-opt-unit]{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* 开关本体是个 <button>（键盘能切），所以先把按钮的默认外观全抹掉，只留下和内置开关
   一模一样的度量与配色：36×20 药丸轨道、2px 内边距、16×16 圆滑块、右移 16px 打开。
   那两处 corner-shape: round 不是装饰：应用会给控件做全局"超椭圆"圆角，内置开关
   明确选择退出（见 ui-primitives 的 Switch.module.css），手写的轨道和滑块也必须退出，
   否则圆角形状和内置开关不一致——那就是"美术风格错位"的来源。 */
[data-dsh-opt-track]{appearance:none;-webkit-appearance:none;box-sizing:border-box;flex:0 0 auto;
  position:relative;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:999px;
  corner-shape:round;background:var(--dsw-alias-border-l3);font:inherit;cursor:pointer;
  transition:background 120ms ease}
[data-dsh-opt-track][data-on="1"]{background:var(--dsw-alias-brand-primary)}
[data-dsh-opt-track]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
[data-dsh-opt-thumb]{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;
  background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease}
[data-dsh-opt-track][data-on="1"] [data-dsh-opt-thumb]{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}
[data-dsh-opt-panel][data-busy="1"]{opacity:.6;pointer-events:none}
[data-dsh-guard-root]{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  pointer-events:auto;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
[data-dsh-guard-mask]{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}
[data-dsh-guard-card]{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;
  gap:20px;width:min(440px,100%);max-height:100%;padding:0 0 24px;overflow:hidden;
  border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
[data-dsh-guard-head]{display:flex;align-items:center;gap:8px;padding:20px 24px 0}
[data-dsh-guard-title]{font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
[data-dsh-guard-body]{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;
  overscroll-behavior:contain;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
[data-dsh-guard-body] p{margin:0}
[data-dsh-guard-amounts]{display:flex;flex-wrap:wrap;gap:8px}
[data-dsh-guard-pill]{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-interactive-bg-hover));
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
[data-dsh-guard-pill] b{color:var(--dsw-alias-state-warn-primary);font-size:13px;font-weight:600}
[data-dsh-guard-digits]{display:flex;gap:12px}
[data-dsh-guard-code]{display:flex;gap:12px;user-select:text}
[data-dsh-guard-code-digit]{box-sizing:border-box;width:44px;height:52px;padding:0;
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);
  text-align:center;font-size:22px;line-height:52px;font-variant-numeric:tabular-nums}
[data-dsh-guard-digit]{box-sizing:border-box;flex:0 0 auto;width:44px;height:52px;padding:0;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-align:center;
  font:inherit;font-size:22px;line-height:52px;font-variant-numeric:tabular-nums;caret-color:var(--dsw-alias-brand-primary)}
[data-dsh-guard-digit]:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
[data-dsh-guard-digit][data-bad="1"]{border-color:var(--dsw-alias-state-error-primary)}
[data-dsh-guard-prompt]{margin:0;padding:10px 12px;max-height:132px;overflow:auto;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);
  color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
[data-dsh-guard-warn]{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);
  font-size:13px;line-height:20px}
[data-dsh-guard-warn][data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
[data-dsh-guard-foot]{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
[data-dsh-guard-foot] button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md);cursor:pointer;
  font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}
[data-dsh-guard-foot] button:disabled{cursor:not-allowed;opacity:.4}
[data-dsh-guard-primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
[data-dsh-guard-primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
[data-dsh-guard-ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-guard-danger]{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
[data-dsh-guard-danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-state-error-primary))}
[data-dsh-guard-fail]{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
`

    /**
     * 读一个开关端点的完整响应；失败返回 undefined。
     *
     * @param {string} endpoint - 端点路径。
     * @returns {Promise<object|undefined>} 响应体。
     */
    async function readEndpoint(endpoint) {
      try {
        const response = await fetch(endpoint, { headers: { accept: 'application/json' } })
        if (response?.ok === false) return undefined
        const body = await response.json()
        return body !== null && typeof body === 'object' ? body : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 读一个开关端点的当前状态。
     *
     * @param {string} endpoint - 端点路径。
     * @param {string} field - 承载布尔值的字段名。
     * @returns {Promise<boolean|undefined>} 状态；读不到返回 undefined。
     */
    async function readSwitch(endpoint, field) {
      const body = await readEndpoint(endpoint)
      const value = body?.[field]
      return typeof value === 'boolean' ? value : undefined
    }

    /**
     * 写一个开关端点。
     *
     * @param {string} endpoint - 端点路径。
     * @param {string} field - 字段名。
     * @param {boolean} value - 目标值。
     * @returns {Promise<boolean|undefined>} 写入后的值；失败返回 undefined。
     */
    async function writeSwitch(endpoint, field, value) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [field]: value === true }),
        })
        // 端点不在、被拒、返回垃圾：一律 undefined。**不能把没写成功当成功**——
        // 界面会因此显示一个假的开启状态。
        if (response?.ok === false) return undefined
        const body = await response.json()
        const next = body?.[field]
        return typeof next === 'boolean' ? next : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 写一格里数字框的值（元）。空串按 0 提交，也就是"不限"。
     *
     * @param {string} endpoint - 端点路径。
     * @param {string} field - 字段名。
     * @param {string} value - 输入框里的原始文本。
     * @returns {Promise<number|undefined>} 写入后的值（元）；失败返回 undefined。
     */
    async function writeAmount(endpoint, field, value) {
      const text = typeof value === 'string' ? value.trim() : ''
      const amount = text === '' ? 0 : Number(text)
      if (!Number.isFinite(amount) || amount < 0) return undefined
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [field]: amount }),
        })
        if (response?.ok === false) return undefined
        const body = await response.json()
        const next = body?.[field]
        return typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 给宿主发一条弹窗答复（放行 / 终止）。
     *
     * @param {string} action - `continue` 或 `terminate`。
     * @param {string} sessionId - 会话 id。
     * @param {string} endpoint - 端点路径。
     * @returns {Promise<object|undefined>} 宿主回执；失败返回 undefined。
     */
    async function postGuardAction(action, sessionId, endpoint) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ guardAction: action, sessionId }),
        })
        if (response?.ok === false) return undefined
        const body = await response.json()
        return body !== null && typeof body === 'object' ? body : undefined
      } catch {
        return undefined
      }
    }

    /** 读开关登记表；读不到就返回空表（面板显示"没有可用开关"）。 */
    async function readRegistry() {
      try {
        const response = await fetch(`${ENDPOINT}?switches=1`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        return Array.isArray(body?.switches) ? body.switches : []
      } catch {
        return []
      }
    }

    /**
     * 把微元金额写成人看的元。
     *
     * 界面上出现的每一笔金额都从这里过，所以"5 元"永远是 5.0000 而不是 5.00000001。
     *
     * @param {unknown} micros - 微元。
     * @returns {string} 元，四位小数。
     */
    function formatYuan(micros) {
      const value = typeof micros === 'number' && Number.isFinite(micros) ? micros : 0
      return (value / 1_000_000).toFixed(4)
    }

    /**
     * 生成六位随机数字（**只在需要时生成一次**，不是每次渲染都换）。
     *
     * `crypto.getRandomValues` 优先；取不到就退回 `Math.random`——验证码是为了拦住
     * "手滑点继续"，不是安全边界，两条路都能用。
     *
     * @returns {string} 六位数字字符串。
     */
    function randomCode() {
      const digits = []
      try {
        const buffer = new Uint8Array(CODE_LENGTH)
        globalThis.crypto.getRandomValues(buffer)
        for (const byte of buffer) digits.push(String(byte % 10))
      } catch {
        for (let index = 0; index < CODE_LENGTH; index += 1) digits.push(String(Math.floor(Math.random() * 10)))
      }
      return digits.join('')
    }

    /**
     * 取用户输入的纯数字，最多六位。
     *
     * @param {unknown} value - 输入框里的值。
     * @returns {string} 纯数字。
     */
    function digitsOf(value) {
      return String(value ?? '').replace(/\D+/g, '').slice(0, CODE_LENGTH)
    }

    /**
     * 优化图标 + 弹层。
     *
     * 组件自己不保存真值：每次打开都重新读，写之前先写后端、再用返回值更新界面，
     * 所以两个标签页、刷新、重启之后显示的都是服务端真正生效的值。
     *
     * @returns {object|null} React 元素。
     */
    function OptimizerButton() {
      const [open, setOpen] = React.useState(false)
      const [rows, setRows] = React.useState([])
      const [status, setStatus] = React.useState('loading')
      /** 每个数字框里正在编辑的文本；失焦前不提交，避免每敲一个键写一次盘。 */
      const [amounts, setAmounts] = React.useState({})
      const rootRef = React.useRef(null)

      /** 拉一次全部开关的状态：同一个端点只请求一次。 */
      const refresh = React.useCallback(async () => {
        const registry = await readRegistry()
        const endpoints = new Map()
        for (const item of registry) {
          if (!endpoints.has(item.endpoint)) endpoints.set(item.endpoint, readEndpoint(item.endpoint))
        }
        const values = new Map()
        for (const [endpoint, promise] of endpoints) values.set(endpoint, await promise)
        const entries = registry.map((item) => {
          const payload = values.get(item.endpoint)
          const field = item.field ?? 'enabled'
          const value = payload === undefined ? undefined : payload[field]
          const input = item.input
          const raw = input === undefined || payload === undefined ? undefined : payload[input.field]
          return {
            item,
            on: typeof value === 'boolean' ? value : undefined,
            amount: typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined,
          }
        })
        // 读不到的（没装、404、字段不对）直接不显示，避免"点了没反应"的开关。
        const usable = entries.filter((entry) => typeof entry.on === 'boolean')
        setRows(usable)
        setAmounts(Object.fromEntries(
          usable.filter((entry) => entry.amount !== undefined).map((entry) => [entry.item.id, entry.amount]),
        ))
        setStatus(usable.length > 0 ? 'ready' : 'failed')
      }, [])

      React.useEffect(() => {
        if (open) void refresh()
      }, [open, refresh])

      React.useEffect(() => {
        if (!open) return () => {}
        const onDown = (event) => {
          if (rootRef.current?.contains?.(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      /**
       * 切换一个开关：先写后端，再用后端返回的值更新显示。
       *
       * @param {object} item - 登记项。
       * @param {boolean} next - 目标值。
       */
      const toggle = async (item, next) => {
        const field = item.field ?? 'enabled'
        setStatus('busy')
        const written = await writeSwitch(item.endpoint, field, next)
        setRows((current) =>
          current.map((entry) => (entry.item.id === item.id ? { ...entry, on: written === true } : entry)),
        )
        setStatus('ready')
      }

      /**
       * 提交一格里数字框的值。
       *
       * 后端回的规范化值会覆盖输入框，所以填 `abc`、`-1`、`1e9` 都会当场看到结果。
       *
       * @param {object} item - 登记项。
       * @param {string} value - 输入框文本。
       */
      const commitAmount = async (item, value) => {
        const input = item.input
        if (input === undefined) return
        setStatus('busy')
        const written = await writeAmount(item.endpoint, input.field, value)
        if (written !== undefined) setAmounts((current) => ({ ...current, [item.id]: String(written) }))
        setStatus('ready')
      }

      const anyOn = rows.some((entry) => entry.on === true)
      const label = document.documentElement?.lang?.startsWith('en') === true ? en : zh

      return React.createElement(
        'div',
        { 'data-dsh-opt-root': '', ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-opt-icon': '',
            'data-on': anyOn ? '1' : '0',
            'aria-haspopup': 'true',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': label.title,
            title: label.title,
            onClick: () => setOpen((value) => !value),
          },
          React.createElement(Sparkle),
          React.createElement('span', null, label.title),
        ),
        open
          ? React.createElement(
            'div',
            { 'data-dsh-opt-panel': '', 'data-busy': status === 'busy' ? '1' : '0', role: 'dialog', 'aria-label': label.title },
            React.createElement(
              'div',
              { 'data-dsh-opt-head': '' },
              React.createElement('span', null, label.title),
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-dsh-opt-close': '',
                  'aria-label': label.close,
                  title: label.close,
                  onClick: () => setOpen(false),
                },
                '✕',
              ),
            ),
            // 行**直接**挂在面板里（原来就有一层"面板自己给 6px 内边距"的排版）。
            // 中间再套一层容器会让行的左右边缘与面板的圆角对不齐，看起来就是"错位"。
            rows.length === 0
              ? React.createElement(
                'div',
                { 'data-dsh-opt-hint': '', style: { padding: '0 8px 4px' } },
                status === 'loading' ? label.loading : label.failed,
              )
              : rows.map(({ item, on }) => SwitchRow({
                key: item.id,
                item,
                on: on === true,
                amount: amounts[item.id],
                label,
                onToggle: () => void toggle(item, !on),
                onAmount: (value) => setAmounts((current) => ({ ...current, [item.id]: value })),
                onCommit: (value) => void commitAmount(item, value),
              })),
          )
          : null,
      )
    }

    /**
     * 一行开关：标题 + 提示 + 可选数字框 + 开关本体。
     *
     * **点行切换、点数字框不切换**：数字框上的事件全部 `stopPropagation`，否则用户想
     * 填预值会顺手把开关关了。开关本体是 `role="switch"` 的按钮，键盘也能切。
     *
     * @param {object} props - `{ item, on, amount, label, onToggle, onAmount, onCommit }`。
     * @returns {object} React 元素。
     */
    function SwitchRow({ item, on, amount, label, onToggle, onAmount, onCommit }) {
      const input = item.input
      return React.createElement(
        'div',
        { 'data-dsh-opt-row': '', onClick: onToggle },
        React.createElement(
          'div',
          { 'data-dsh-opt-text': '' },
          React.createElement(
            'span',
            { 'data-dsh-opt-main': '' },
            React.createElement('span', { 'data-dsh-opt-label': '' }, item.label?.[label === en ? 'en' : 'zh'] ?? item.id),
            input === undefined
              ? null
              : React.createElement(
                'span',
                {
                  'data-dsh-opt-amount': '',
                  // 数字框上的事件全都不许冒泡到行上：用户想填预值，不该顺手把开关关了。
                  onClick: (event) => event.stopPropagation(),
                  onKeyUp: (event) => event.stopPropagation(),
                },
                React.createElement('input', {
                  type: 'text',
                  inputMode: 'decimal',
                  'aria-label': input.placeholder?.[label === en ? 'en' : 'zh'] ?? item.id,
                  placeholder: input.placeholder?.[label === en ? 'en' : 'zh'] ?? '',
                  value: amount ?? '',
                  onMouseDown: (event) => event.stopPropagation(),
                  onChange: (event) => onAmount(event.target.value),
                  onKeyDown: (event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') event.currentTarget.blur()
                  },
                  onBlur: (event) => onCommit(event.target.value),
                }),
                React.createElement('span', { 'data-dsh-opt-unit': '' }, input.unit?.[label === en ? 'en' : 'zh'] ?? ''),
              ),
          ),
          React.createElement('span', { 'data-dsh-opt-hint': '' }, item.hint?.[label === en ? 'en' : 'zh'] ?? ''),
        ),
        React.createElement(
          'span',
          { 'data-dsh-opt-tail': '' },
          React.createElement(
            'button',
            {
              type: 'button',
              role: 'switch',
              'aria-checked': on ? 'true' : 'false',
              'aria-label': item.label?.[label === en ? 'en' : 'zh'] ?? item.id,
              'data-dsh-opt-track': '',
              'data-on': on ? '1' : '0',
              onClick: (event) => {
                event.stopPropagation()
                onToggle()
              },
            },
            React.createElement('span', { 'data-dsh-opt-thumb': '' }),
          ),
        ),
      )
    }

    /**
     * 花费预警弹窗。
     *
     * 三屏，跟着宿主的拦截状态走（不自己判断金额）：
     * 1. `ask` —— 说明花了多少 / 预值多少，六位数字 + 验证框；
     * 2. `ending` —— 终止请求发出中；
     * 3. `ended` —— 终止之后：只说明已经停手、没让模型删任何东西，并把**本会话最初的提示词**摆出来。
     *
     * @param {object} props - slot 注入的 `{ sessionId, useProjection, t }`。
     * @returns {object|null} React 元素。
     */
    function CostGuard({ sessionId, useProjection, t }) {
      const projection = useProjection('optimizerCostGuard')
      const [entered, setEntered] = React.useState('')
      const [mode, setMode] = React.useState('ask')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [ended, setEnded] = React.useState(null)
      /** 终止那一屏只能由用户自己关掉：验证码重抽不该把它顶回第一屏。 */
      const [acknowledged, setAcknowledged] = React.useState(false)
      /**
       * 这一屏**正在展示**的那组数字，以及"这是第几屏"。
       *
       * 抽签结果存在 ref 里、**渲染期取用**：这样"上面显示的数字"和"校验用的数字"在
       * 同一帧里就是同一个值。曾经用 `useState` 存它、展示读状态，结果多画一帧才对齐，
       * 出现"照着屏幕抄也过不了关"的死局（显示 841121、校验 841120）。
       */
      const shown = React.useRef('')
      const boxes = React.useRef([])
      const label = document.documentElement?.lang?.startsWith('en') === true ? en : zh
      void t
      const tripped = projection?.guard === 'tripped'
      const open = tripped === true || (ended !== null && !acknowledged)

      // 本轮拦截要有数字：没有就抽一组。**渲染期做**，幂等，所以重画多少次都是同一组。
      if (tripped && shown.current === '') shown.current = randomCode()

      // "这是第几屏"：会话 + 本会话被拦了几次。批次一变（新的拦截 / 换了会话）就换一组
      // 数字、回到"询问"那一屏、清掉上一屏的输入。
      //
      // 关键是**只在批次真的变了的时候才清**：把 `setEntered('')` 放在每次渲染都跑的地方
      // （或依赖写成每次渲染都变的表达式），用户敲进去的数字会被下一次渲染立刻抹掉——
      // 表现就是"只能填进一位"。这场调试花了很久，别再改回去。
      const batch = `${sessionId}\u0000${tripped ? projection?.hits ?? 0 : -1}`
      const lastBatch = React.useRef('')
      if (lastBatch.current !== batch) {
        lastBatch.current = batch
        if (tripped) shown.current = randomCode()
        setMode('ask')
        setEntered('')
        setFailure('')
        setEnded(null)
        setAcknowledged(false)
      }

      // 弹窗一开就把焦点放进第一个数字框，用户可以直接敲。
      React.useEffect(() => {
        if (!open || mode !== 'ask') return
        boxes.current[0]?.focus?.()
      }, [open, mode, shown.current])

      if (!open) return null

      const shownCode = shown.current
      const correct = entered.length === CODE_LENGTH && entered === shownCode

      /** 往一个数字框里写字：满了自动跳下一个；写了非数字就一个都不动。 */
      const put = (index, raw) => {
        const digit = digitsOf(raw).slice(-1)
        if (digit === '') {
          setEntered((current) => `${current.slice(0, index)}${current.slice(index + 1)}`)
          setFailure('')
          return
        }
        const next = `${entered.slice(0, index)}${digit}${entered.slice(index + 1)}`
        setEntered(next)
        setFailure('')
        boxes.current[index + 1]?.focus?.()
      }

      /** 粘贴：一次填满六格。 */
      const paste = (index, text) => {
        const digits = digitsOf(text)
        if (digits === '') return
        const next = `${entered.slice(0, index)}${digits}`.slice(0, CODE_LENGTH)
        setEntered(next)
        setFailure('')
        boxes.current[Math.min(next.length, CODE_LENGTH - 1)]?.focus?.()
      }

      /** 放行：告诉宿主"验证过了"，宿主负责唤醒这一轮。 */
      const resume = async () => {
        if (!correct || busy) return
        if (typeof sessionId !== 'string' || sessionId === '') {
          setFailure(label.continueFailed)
          return
        }
        setBusy(true)
        setFailure('')
        const result = await postGuardAction('continue', sessionId, ENDPOINT)
        setBusy(false)
        if (result?.delivered === true) return
        if (result === undefined) {
          setFailure(label.continueFailed)
          return
        }
        setFailure(result.why === 'no-agent' ? label.notEnough : label.continueFailed)
      }

      /** 终止：让宿主停手，然后只把本会话最初的提示词拿回来给用户看。 */
      const terminate = async () => {
        if (busy) return
        if (typeof sessionId !== 'string' || sessionId === '') {
          // 认不出会话就什么都不做：宁可让用户重开一次，也不能把"终止"发到别的会话上。
          setFailure(label.continueFailed)
          return
        }
        setBusy(true)
        setFailure('')
        setMode('ending')
        const result = await postGuardAction('terminate', sessionId, ENDPOINT)
        setBusy(false)
        setEnded({ stopped: result?.terminated === true, prompt: typeof result?.prompt === 'string' ? result.prompt : '' })
        setMode('ended')
      }

      const amounts = React.createElement(
        'div',
        { 'data-dsh-guard-amounts': '' },
        React.createElement(
          'span',
          { 'data-dsh-guard-pill': '' },
          label.spent,
          React.createElement('b', null, `¥${formatYuan(projection?.micros)}`),
        ),
        React.createElement(
          'span',
          { 'data-dsh-guard-pill': '' },
          label.limit,
          React.createElement('b', null, `¥${formatYuan(projection?.limit)}`),
        ),
        typeof projection?.unpricedTokens === 'number' && projection.unpricedTokens > 0
          ? React.createElement(
            'span',
            { 'data-dsh-guard-pill': '' },
            `${projection.unpricedTokens} ${label.unpriced}`,
          )
          : null,
      )

      /** 第一屏：说明 + 验证。 */
      const ask = React.createElement(
        React.Fragment,
        null,
        React.createElement('p', null, label.askLead),
        amounts,
        React.createElement('p', null, label.verifyLead),
        React.createElement(
          'div',
          { 'data-dsh-guard-code': '', role: 'img', 'aria-label': `${label.verifyLabel} ${shownCode}` },
          ...shownCode.split('').map((digit, index) => React.createElement(
            'span',
            { key: index, 'data-dsh-guard-code-digit': '' },
            digit,
          )),
        ),
        React.createElement(
          'div',
          { 'data-dsh-guard-digits': '', role: 'group', 'aria-label': label.verifyLabel },
          Array.from({ length: CODE_LENGTH }, (_unused, index) =>
            React.createElement('input', {
              key: index,
              ref: (node) => {
                boxes.current[index] = node
              },
              'data-dsh-guard-digit': '',
              'data-bad': failure !== '' ? '1' : '0',
              type: 'text',
              inputMode: 'numeric',
              autoComplete: 'off',
              maxLength: 1,
              value: entered[index] ?? '',
              'aria-label': label.inputLabel.replace('%d', String(index + 1)),
              onChange: (event) => put(index, event.target.value),
              onPaste: (event) => {
                event.preventDefault()
                paste(index, event.clipboardData?.getData?.('text') ?? '')
              },
              onKeyDown: (event) => {
                if (event.key === 'Backspace' && (entered[index] ?? '') === '') {
                  boxes.current[index - 1]?.focus?.()
                }
                if (event.key === 'ArrowLeft') boxes.current[index - 1]?.focus?.()
                if (event.key === 'ArrowRight') boxes.current[index + 1]?.focus?.()
                if (event.key === 'Enter' && correct) void resume()
              },
            }),
          ),
        ),
        React.createElement('span', { 'data-dsh-opt-hint': '' }, label.inputHint),
        failure === ''
          ? null
          : React.createElement('span', { 'data-dsh-guard-fail': '' }, failure),
      )

      /**
       * 第三屏：用户选了"终止任务"之后。
       *
       * 只做两件事：说清楚"已经停手了、没有下任何删除指令"，再把**本会话最初的提示词**
       * 原样摆出来给用户看。不再展示、也不下发任何清理/删除指令——产出的东西怎么处理
       * 是用户的决定。
       */
      const endedView = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          { 'data-dsh-guard-warn': '' },
          React.createElement('span', null, label.endStopped),
        ),
        React.createElement('p', null, label.originalPrompt),
        React.createElement(
          'pre',
          { 'data-dsh-guard-prompt': '' },
          ended?.prompt === '' || ended?.prompt === undefined ? label.noPrompt : ended.prompt,
        ),
        React.createElement(
          'div',
          { 'data-dsh-guard-foot': '' },
          React.createElement(
            'button',
            {
              type: 'button',
              'data-dsh-guard-primary': '',
              onClick: () => setAcknowledged(true),
            },
            label.keepClosed,
          ),
        ),
        React.createElement('span', { 'data-dsh-opt-hint': '' }, label.keepClosedHint),
      )

      return React.createElement(
        'div',
        { 'data-dsh-guard-root': '', role: 'presentation' },
        React.createElement('div', { 'data-dsh-guard-mask': '', 'aria-hidden': 'true' }),
        React.createElement(
          'div',
          {
            'data-dsh-guard-card': '',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': label.askTitle,
            tabIndex: -1,
          },
          React.createElement(
            'div',
            { 'data-dsh-guard-head': '' },
            React.createElement('span', { 'data-dsh-guard-title': '' }, label.askTitle),
          ),
          React.createElement('div', { 'data-dsh-guard-body': '' }, ended === null ? ask : endedView),
          ended === null
            ? React.createElement(
              'div',
              { 'data-dsh-guard-foot': '' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-dsh-guard-danger': '',
                  disabled: busy,
                  onClick: () => void terminate(),
                },
                mode === 'ending' ? label.terminating : label.terminate,
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-dsh-guard-primary': '',
                  disabled: !correct || busy,
                  onClick: () => void resume(),
                },
                busy && mode === 'ask' ? label.continuing : label.continueAction,
              ),
            )
            : null,
        ),
      )
    }

    /**
     * 图标：四角星（"优化"的通用符号），跟随文字颜色。
     *
     * @returns {object} React 元素。
     */
    function Sparkle() {
      return React.createElement(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M8 1.5l1.6 4.1 4.1 1.6-4.1 1.6L8 12.9 6.4 8.8 2.3 7.2l4.1-1.6L8 1.5z',
        }),
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M12.6 11.1l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7z',
        }),
      )
    }

    exports.inject = ['slots']

    /**
     * 客户端插件主体：注入样式，把优化图标与花费预警弹窗挂到输入栏那一排。
     *
     * 弹窗也注册在同一个 slot 上：它是会话作用域的，`useProjection` 与 `sessionId`
     * 都是 slot 注入的，不需要自己去找会话。
     *
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
        const node = document.createElement('style')
        node.id = STYLE_ID
        node.textContent = style
        document.head.append(node)
      }
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'optimizer', order: 20 },
          OptimizerButton,
        ),
      )
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'optimizer-cost-guard', order: 21 },
          CostGuard,
        ),
      )
    }

    exports.apply = apply
    exports.readRegistry = readRegistry
    exports.readSwitch = readSwitch
    exports.writeSwitch = writeSwitch
    exports.writeAmount = writeAmount
    exports.postGuardAction = postGuardAction
    exports.formatYuan = formatYuan
    exports.randomCode = randomCode
    exports.digitsOf = digitsOf
    exports.CostGuard = CostGuard
    exports.OptimizerButton = OptimizerButton
    return module.exports
  },
})
