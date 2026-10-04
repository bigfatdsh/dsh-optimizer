/**
 * 轻重组 → 该模型**真实支持**的推理档位。
 *
 * ## 这里唯一会出错的地方
 *
 * 请求头里带一个模型不认识的 effort，宿主会直接抛 `UNSUPPORTED_REASONING_EFFORT`——
 * 也就是"选错档位 = 这次回答失败"。所以本模块所有路径都必须落在 `available` 里：
 * 查得到就用，查不到就退回原样（`undefined` = 宿主自己决定）。
 *
 * ## 桶与档位的差别
 *
 * 桶跨模型；档位（off/low/high/max，或 minimal/…）是模型自己的词汇。不同模型的档位
 * 数量与名字都不一样，所以只能按"序"对齐：把该模型的档位当阶梯，桶按固定比例投影。
 *
 * @module dsh-optimizer/efforts
 */

/**
 * 桶在阶梯上的相对位置（0..1），再四舍五入到最近的台阶。
 *
 * 四档（DeepSeek 的 off/low/high/max）下正好一对一：quiet=off、light=low、
 * standard=high、heavy=max。档位更少时自动合并，更多时自动铺开：
 *
 *   * 三档 → quiet=最低、light=中、standard/heavy=最高；
 *   * 两档 → quiet/light=最低、standard/heavy=最高。
 */
const RATIO = { quiet: 0, light: 0.34, standard: 0.67, heavy: 1 }

/**
 * 各家的档位名 → 阶梯序。名字里带数字的（`reasoning-3`）走"声明顺序"。
 */
const RANK = new Map([
  ['off', 0],
  ['none', 0],
  ['disabled', 0],
  ['minimal', 1],
  ['low', 1],
  ['light', 1],
  ['medium', 2],
  ['mid', 2],
  ['standard', 2],
  ['normal', 2],
  ['high', 3],
  ['max', 4],
  ['xhigh', 4],
  ['extra-high', 4],
  ['ultra', 4],
])

/**
 * 一个档位在阶梯上的序。认不出名字就按它在声明列表里的位置排。
 *
 * @param {string} id - 档位 id 或名字。
 * @param {number} index - 声明顺序。
 * @returns {number} 序，越大越费。
 */
function rankOf(id, index) {
  const ranked = RANK.get(String(id).trim().toLowerCase())
  return ranked === undefined ? index : ranked
}

/**
 * 模型支持的档位（已按"省→费"排序）。
 *
 * @param {unknown} reasoning - 模型目录里的 `reasoning` 元数据。
 * @returns {Array<{ id: string, rank: number }>} 档位表；模型不支持推理时为空。
 */
export function ladder(reasoning) {
  const efforts = reasoning !== null && typeof reasoning === 'object' ? reasoning.efforts : undefined
  if (!Array.isArray(efforts)) return []
  const seen = new Set()
  const out = []
  for (const effort of efforts) {
    const id = effort !== null && typeof effort === 'object' ? effort.id : undefined
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, rank: rankOf(id, out.length) })
  }
  out.sort((left, right) => left.rank - right.rank)
  return out
}

/**
 * 按桶投影到阶梯上的某一档。
 *
 * @param {ReadonlyArray<{ id: string, rank: number }>} levels - `ladder()` 的结果。
 * @param {string} bucket - 轻重组。
 * @returns {string | undefined} 档位 id；阶梯为空时是 `undefined`。
 */
export function afford(levels, bucket) {
  if (levels.length === 0) return undefined
  const ratio = RATIO[bucket] ?? RATIO.standard
  const at = Math.round(ratio * (levels.length - 1))
  return levels[Math.max(0, Math.min(levels.length - 1, at))].id
}

/**
 * 定这一次请求最终要用的档位。
 *
 * @param {object} input - 输入。
 * @param {string} input.bucket - 本轮的轻重组。
 * @param {unknown} input.reasoning - 该模型目录里的 `reasoning` 元数据。
 * @param {string} [input.forced] - 配置里指定的档位；该模型不支持时忽略。
 * @returns {{ effort: string | undefined, levels: string[], source: 'forced' | 'bucket' | 'none' }} 结果。
 */
export function resolveEffort(input) {
  const levels = ladder(input.reasoning)
  const ids = levels.map((level) => level.id)
  if (ids.length === 0) return { effort: undefined, levels: ids, source: 'none' }
  if (input.forced !== undefined && ids.includes(input.forced)) {
    return { effort: input.forced, levels: ids, source: 'forced' }
  }
  return { effort: afford(levels, input.bucket), levels: ids, source: 'bucket' }
}
