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
    if (this.#file === undefined) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') this.#onError(error)
      return {}
    }
  }

  /** 写盘；先读回再合并，任何失败只上报，不影响内存值。 */
  #write() {
    if (this.#file === undefined) return
    const file = this.#file
    const temp = `${file}.${process.pid}.tmp`
    const merged = { ...this.#read(), [this.#field]: this.#on }
    try {
      writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      this.#onError(error)
      try {
        rmSync(temp, { force: true })
      } catch {
        // 清理失败无所谓：临时文件带 pid，不会污染下次读取。
      }
    }
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
