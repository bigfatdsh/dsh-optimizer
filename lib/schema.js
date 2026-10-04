/**
 * 插件配置。只有精简化开关相关的那几项。
 *
 * 用 Standard Schema v1（`~standard.validate`）。**未知键一律拒绝**：配置写错当场报错，
 * 不会静默失效（实测教训：旧版把 `enabled` 写错时看起来"配了却没生效"）。
 *
 * @module dsh-optimizer/schema
 */

/** 一次校验里收集到的问题。 */
class Field {
  /**
   * @param {object} [options] - `{ default, optional }`。
   */
  constructor(options = {}) {
    this.default = options.default
    this.optional = options.optional === true
  }

  /**
   * @param {unknown} value - 待校验的值。
   * @param {string} path - 报错路径。
   * @param {string[]} issues - 问题收集。
   * @returns {unknown} 通过后的值。
   */
  check(value, path, issues) {
    void value
    void path
    void issues
    return undefined
  }
}

/** 布尔字段。 */
class BooleanField extends Field {
  check(value, path, issues) {
    if (typeof value === 'boolean') return value
    if (value === undefined && this.optional) return undefined
    if (value === undefined && this.default !== undefined) return this.default
    issues.push(`${path}: expected a boolean, got ${value === undefined ? 'nothing' : typeof value}`)
    return this.default
  }
}

/** 非空字符串字段。 */
class StringField extends Field {
  check(value, path, issues) {
    if (typeof value === 'string' && value !== '') return value
    if (value === undefined) {
      if (this.optional) return undefined
      if (this.default !== undefined) return this.default
    }
    issues.push(`${path}: expected a non-empty string`)
    return this.default
  }
}

/** 配置字段表。 */
export const Config = {
  /** 精简化在**首次**装配时的默认值（之后以状态文件里的值为准）。 */
  conciseDefault: new BooleanField({ default: false }),
  /** 把界面开关写到 `<DSH_HOME>/optimizer.json`，重启后保持上次选择。 */
  persist: new BooleanField({ default: true }),
  /** 每次装配打一行 info 日志（排查"到底注入没注入"时打开）。 */
  log: new BooleanField({ default: false }),
  /** 状态文件路径；留空就用 `<DSH_HOME>/optimizer.json`。 */
  file: new StringField({ default: undefined, optional: true }),
}

Object.defineProperty(Config, '~standard', {
  value: {
    version: 1,
    vendor: 'dsh-optimizer',
    /**
     * @param {unknown} value - 待校验配置。
     * @returns {{ value?: object, issues?: {message: string}[] }} 校验结果。
     */
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config: expected an object' }] }
      }
      const source = /** @type {Record<string, unknown>} */ (value)
      const issues = []
      const known = new Set(Object.keys(Config))
      for (const key of Object.keys(source)) {
        if (!known.has(key)) issues.push({ message: `${key}: unknown option` })
      }
      const resolved = {}
      for (const [key, field] of Object.entries(Config)) {
        resolved[key] = field.check(source[key], key, issues)
      }
      if (issues.length > 0) return { issues }
      return { value: resolved }
    },
  },
})

/**
 * 解析配置：把校验结果落成一份带默认值的完整配置。
 *
 * @param {unknown} raw - 原始配置。
 * @returns {{ conciseDefault: boolean, persist: boolean, log: boolean, file: string|undefined }} 完整配置。
 */
export function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw)
  if (result.issues !== undefined || result.value === undefined) {
    // 配置非法时退回"全默认"：宁可默认行为，也不要半截配置。
    const fallback = {}
    for (const [key, field] of Object.entries(Config)) fallback[key] = field.default
    return /** @type {any} */ (fallback)
  }
  return /** @type {any} */ (result.value)
}
