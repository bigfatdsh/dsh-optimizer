/**
 * 两个开关的状态：`concise`（精简化输出）与 `auto`（推理等级）。
 *
 * 存在同一个文件 `<DSH_HOME>/optimizer.json` 里，一个键一个字段。**写盘先读回再合并**：
 * 直接整文件覆盖会把另一个开关的选择抹掉。
 *
 * 读不出、写不进都退回默认值——**装配永不因为状态问题失败**。
 *
 * @module dsh-optimizer/state
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 状态文件名。 */
export const STORE_FILENAME = 'optimizer.json'

/**
 * 解析 DSH 主目录。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * 状态文件路径。
 *
 * @param {string} [home] - 覆盖 DSH 主目录（测试用）。
 * @returns {string} 绝对路径。
 */
export function statePath(home) {
  const base = typeof home === 'string' && home !== '' ? home : resolveDshHome()
  return join(base, STORE_FILENAME)
}

/**
 * 读一个状态文件。文件不存在返回空对象；解析失败上报并返回空对象。
 *
 * @param {string|undefined} file - 文件路径；undefined 表示不落盘。
 * @param {(error: unknown) => void} onError - 失败上报。
 * @returns {Record<string, unknown>} 文件内容。
 */
function readStore(file, onError) {
  if (file === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') onError(error)
    return {}
  }
}

/**
 * 写一个字段进状态文件；**先读回再合并**，所以同一个文件上的多个键互不覆盖。
 *
 * @param {string|undefined} file - 文件路径；undefined 表示不落盘。
 * @param {string} field - 字段名。
 * @param {unknown} value - 字段值。
 * @param {(error: unknown) => void} onError - 失败上报。
 */
function writeStore(file, field, value, onError) {
  if (file === undefined) return
  const temp = `${file}.${process.pid}.tmp`
  const merged = { ...readStore(file, onError), [field]: value }
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    onError(error)
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败无所谓：临时文件带 pid，不会污染下次读取。
    }
  }
}

/**
 * 一个布尔开关。
 *
 * 同一个文件上可以挂多个实例；写盘时互相保留对方字段，也保留不认识的键。
 */
export class ToggleState {
  /** @type {string} */
  #field
  /** @type {boolean} */
  #on
  /** @type {string|undefined} */
  #file
  /** @type {(error: unknown) => void} */
  #onError

  /**
   * @param {object} options - `{ field, initial, file, onError }`。
   * @param {string} options.field - 状态文件里的字段名。
   * @param {boolean} [options.initial] - 读盘前的初值。
   * @param {string} [options.file] - 状态文件；空串表示不落盘。
   * @param {(error: unknown) => void} [options.onError] - 写盘失败上报。
   */
  constructor(options) {
    this.#field = options.field
    this.#on = options.initial === true
    this.#file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
    // **同步**读一次盘。实测踩过：原来是异步 load()，而插件的第一个请求可能早于
    // 它完成——那一轮读到的还是内存默认值，表现为"明明开着 auto，第一轮却不动作"。
    this.load()
  }

  /** @returns {boolean} 当前是否开启。 */
  get() {
    return this.#on
  }

  /**
   * 写入开关。
   *
   * @param {unknown} next - 目标值，按真值解释。
   * @returns {boolean} 写入后的值。
   */
  set(next) {
    this.#on = next === true
    this.#write()
    return this.#on
  }

  /**
   * 从盘上读回上次的选择。读不到、读坏都保持当前值。
   *
   * 同步实现：调用方（构造）需要在下一个请求之前就拿到真实值。
   *
   * @returns {boolean} 是否读到了一个有效值。
   */
  load() {
    const value = this.#read()[this.#field]
    if (typeof value !== 'boolean') return false
    this.#on = value
    return true
  }

  /**
   * 读整个文件。文件不存在返回空对象；解析失败上报并返回空对象。
   *
   * @returns {Record<string, unknown>} 文件内容。
   */
  #read() {
    return readStore(this.#file, this.#onError)
  }

  /** 写盘；先读回再合并，任何失败只上报，不影响内存值。 */
  #write() {
    writeStore(this.#file, this.#field, this.#on, this.#onError)
  }
}

/** 精简化输出的开关（历史名字，行为不变）。 */
export class ConciseState extends ToggleState {
  /**
   * @param {object} [options] - `{ initial, file, onError }`。
   */
  constructor(options = {}) {
    super({ field: 'concise', ...options })
  }
}

/**
 * 状态文件里的一个**整数值**（花费预值用）。
 *
 * 与 {@link ToggleState} 同一条规矩：构造时同步读回、写盘先读再合并、任何失败只上报。
 * 值域在这里就收敛好——界面传来的可能是空串、小数、负数、`NaN`，落盘前一律
 * 归一成非负安全整数，**读盘时也一样**（手改坏了配置文件不该让功能变成 NaN 比较）。
 */
export class NumberState {
  /** @type {string} */
  #field
  /** @type {number} */
  #value
  /** @type {string|undefined} */
  #file
  /** @type {(error: unknown) => void} */
  #onError

  /**
   * @param {object} options - `{ field, initial, file, onError }`。
   * @param {string} options.field - 状态文件里的字段名。
   * @param {number} [options.initial] - 读盘前的初值。
   * @param {string} [options.file] - 状态文件；空串表示不落盘。
   * @param {(error: unknown) => void} [options.onError] - 写盘失败上报。
   */
  constructor(options) {
    this.#field = options.field
    this.#value = normalizeNumber(options.initial)
    this.#file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
    const stored = this.#read()[this.#field]
    if (stored !== undefined) this.#value = normalizeNumber(stored)
  }

  /** @returns {number} 当前值。 */
  get() {
    return this.#value
  }

  /**
   * @param {unknown} next - 目标值；非法值被忽略（保持原值）。
   * @returns {boolean} 是否真的改了。
   */
  set(next) {
    const value = normalizeNumber(next)
    if (value === this.#value) return false
    this.#value = value
    this.#write()
    return true
  }

  /** @returns {Record<string, unknown>} 状态文件内容；读不出就是空对象。 */
  #read() {
    return readStore(this.#file, this.#onError)
  }

  /** 写盘；先读回再合并，任何失败只上报，不影响内存值。 */
  #write() {
    writeStore(this.#file, this.#field, this.#value, this.#onError)
  }
}

/**
 * 把任意输入归一成非负安全整数；非法一律 0。
 *
 * @param {unknown} value - 原始值。
 * @returns {number} 归一后的值。
 */
export function normalizeNumber(value) {
  const number = typeof value === 'string' ? Number(value.trim() === '' ? 0 : value.trim()) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return 0
  const rounded = Math.round(number)
  return Number.isSafeInteger(rounded) ? rounded : 0
}
