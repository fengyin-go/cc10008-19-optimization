import type { DatasetRow, QueryCondition } from './types'

/**
 * 本地模拟数据集。纯前端没有后端，用确定性生成的数据代替真实表；
 * 每次「刷新数据」都会产生新版本号，缓存按版本号失效——刷新后必须从第一页重新取数。
 */
export interface DatasetSnapshot {
  name: string
  version: number
  fields: string[]
  rows: DatasetRow[]
}

const REGIONS = ['华东', '华北', '华南', '西南', '西北']
const CATEGORIES = ['电子', '服饰', '食品', '家居', '图书']
const FIELD_NAMES = ['id', 'region', 'category', 'amount', 'score', 'active']

function buildRows(count: number, salt: number): DatasetRow[] {
  const rows: DatasetRow[] = []
  for (let index = 0; index < count; index += 1) {
    // 确定性生成：同 salt 同长度得到完全相同的数据，便于测试断言。
    const seed = (index + 1) * 7 + salt * 131
    rows.push({
      id: index + 1,
      region: REGIONS[seed % REGIONS.length],
      category: CATEGORIES[(seed >> 2) % CATEGORIES.length],
      amount: ((seed * 37) % 9000) + 100,
      score: ((seed * 13) % 500) / 10,
      active: seed % 2 === 0,
    })
  }
  return rows
}

export class LocalDataset {
  readonly name: string
  readonly fields: string[] = [...FIELD_NAMES]
  private version = 1
  private rows: DatasetRow[]
  private readonly baseCount: number

  constructor(name = 'sales_orders', baseCount = 257) {
    this.name = name
    this.baseCount = baseCount
    this.rows = buildRows(baseCount, this.version)
  }

  get currentVersion(): number {
    return this.version
  }

  snapshot(): DatasetSnapshot {
    // 深拷贝，避免调用方改动污染引擎内部数据。
    return {
      name: this.name,
      version: this.version,
      fields: [...this.fields],
      rows: this.rows.map((row) => ({ ...row })),
    }
  }

  /**
   * 刷新目标数据集：版本号 +1 并重排/变更数据。
   * 刷新后旧缓存因版本不匹配整体失效，新查询从第一页开始。
   */
  refresh(): DatasetSnapshot {
    this.version += 1
    // 行数随版本小幅变化，模拟目标数据集「稍一变化」。
    const count = this.baseCount + ((this.version % 3) - 1) * 11
    this.rows = buildRows(Math.max(1, count), this.version)
    return this.snapshot()
  }
}

/**
 * 过滤表达式解析：
 * - "field=value" 等值（字符串/布尔按字符串比较，数字按数值比较）
 * - "field~value" 包含匹配
 * 多条以分号分隔，AND 组合。空表达式表示不过滤。
 */
function matchFilter(row: DatasetRow, expression: string): boolean {
  const clauses = expression
    .split(';')
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
  return clauses.every((clause) => {
    const operator = clause.includes('~') ? '~' : '='
    const [rawField, rawValue] = clause.split(operator)
    if (rawField === undefined || rawValue === undefined) {
      return true
    }
    const field = rawField.trim()
    const expected = rawValue.trim()
    const actual = row[field]
    if (actual === undefined) {
      return false
    }
    if (operator === '~') {
      return String(actual).includes(expected)
    }
    if (typeof actual === 'number') {
      return actual === Number(expected)
    }
    if (typeof actual === 'boolean') {
      return String(actual) === expected
    }
    return actual === expected
  })
}

function compareValues(left: DatasetRow[string], right: DatasetRow[string]): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right)
  }
  return String(left).localeCompare(String(right), 'zh-Hans-CN')
}

export interface PreparedQuery {
  rows: DatasetRow[]
  total: number
  truncated: boolean
}

/**
 * 按条件准备全量结果：过滤 → 排序 → 最大行数截断。
 * 总数与分页共用同一份准备结果，保证「响应只取当前页窗口，但总数仍按同一规则计算」。
 */
export function prepareQuery(dataset: DatasetSnapshot, condition: QueryCondition): PreparedQuery {
  const filtered = condition.filter.trim()
    ? dataset.rows.filter((row) => matchFilter(row, condition.filter))
    : [...dataset.rows]

  const sortField = condition.sortField.trim()
  filtered.sort((left, right) => {
    const compared = compareValues(left[sortField] ?? '', right[sortField] ?? '')
    return condition.sortOrder === 'desc' ? -compared : compared
  })

  const truncated = filtered.length > condition.maxRows
  const limited = truncated ? filtered.slice(0, condition.maxRows) : filtered
  return { rows: limited, total: limited.length, truncated }
}

/** 页码越界纠正：超过末页时回到实际末页；页码小于 1 时回到第一页。 */
export function clampPage(requestedPage: number, totalPages: number): number {
  if (requestedPage < 1) {
    return 1
  }
  if (totalPages === 0) {
    return 1
  }
  return Math.min(requestedPage, totalPages)
}

/** 取当前页窗口切片（不修改全量数组）。 */
export function pageWindow(
  rows: DatasetRow[],
  page: number,
  size: number,
): DatasetRow[] {
  const start = (page - 1) * size
  return rows.slice(start, start + size).map((row) => ({ ...row }))
}
