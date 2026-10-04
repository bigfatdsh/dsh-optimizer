/**
 * 精简化开关的状态。
 *
 * 只有一件事要记住：这个开关是开还是关。状态写进
 * `<DSH_HOME>/optimizer.json`，
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
 * 精简化开关。
 *
 * 内存是唯一真值来源，写盘只是尽力而为；盘上的值在启动时读一次。
 */
export class ConciseState {
  /** @type {boolean} */
  #on
  /** @type {string|undefined} */
  #file
  /** @type {(error: unknown) => void} */
  #onError

  /**
   * @param {object} [options] - `{ initial, file, onError }`。
   */
  constructor(options = {}) {
    this.#on = options.initial === true
    this.#file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
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
   * @returns {Promise<boolean>} 是否读到了一个有效值。
   */
  async load() {
    if (this.#file === undefined) return false
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      const value = parsed !== null && typeof parsed === 'object' ? parsed.concise : undefined
      if (typeof value !== 'boolean') return false
      this.#on = value
      return true
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') this.#onError(error)
      return false
    }
  }

  /** 写盘；任何失败只上报，不影响内存值。 */
  #write() {
    if (this.#file === undefined) return
    const file = this.#file
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ concise: this.#on }, null, 2)}\n`, 'utf8')
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
