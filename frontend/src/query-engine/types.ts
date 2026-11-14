/**
 * 查询引擎的公共类型。
 * 引擎与 React 解耦：界面、测试都只依赖这里的结构，方便单测与以后替换数据来源。
 */

/** 数据集里的一行：字段值只允许基础标量，便于排序、过滤与序列化缓存。 */
export type DatasetRow = Record<string, string | number | boolean>

/** 查询条件（草稿态也用这个结构，未填完整时字段允许为空串）。 */
export interface QueryCondition {
  /** 目标数据集名称，空串表示草稿未填完整。 */
  dataset: string
  /** 过滤表达式，形如 "region=华东"、"category~电子"，多条以分号分隔（AND）。 */
  filter: string
  /** 返回字段，顺序即展示列顺序；顺序变化必须产生不同缓存键。 */
  fields: string[]
  /** 排序字段与方向。 */
  sortField: string
  sortOrder: 'asc' | 'desc'
  /** 分页大小（每页窗口行数）。 */
  pageSize: number
  /** 最大行数：全量结果的截断上限，参与缓存键。 */
  maxRows: number
  /** 超时秒数：参与缓存键，不同阈值不能共享结果。 */
  timeoutSec: number
}

/** 规则校验失败项：字段级提示，多个问题一次性给出。 */
export interface ValidationIssue {
  field: keyof QueryCondition | 'params'
  message: string
}

/** 校验结果：通过时 issues 为空。重复参数等一致性判定也走这里。 */
export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

/** 批次生命周期状态。终止中不留中间态，终止动作直接落到「已终止」。 */
export type BatchStatus = 'running' | 'complete' | 'timeout' | 'terminated'

/**
 * 一次取页结果。
 * - zeroRows：过滤后总数为 0（第一页也没有行）
 * - emptyPage：总数大于 0，但请求页超出窗口（返回的是被纠正后的末页信息，items 为空仅在越界且末页也无窗口时）
 * 两者必须区分表示，不能都用空数组兜底。
 */
export interface QueryPage {
  /** 本次取页归属的批次号，报表侧按批次读取完整结果。 */
  batchId: string
  /** 实际使用的页码：越界请求会被纠正到实际末页。 */
  page: number
  /** 请求时传入的原始页码，便于界面提示「已回到末页」。 */
  requestedPage: number
  size: number
  /** 当前页窗口内的行，只含请求窗口，不含其他页。 */
  items: DatasetRow[]
  /** 按同一规则计算的全量总数（截断后的命中总数）。 */
  total: number
  totalPages: number
  /** 命中 0 行。 */
  zeroRows: boolean
  /** 请求页超出末页，被纠正到实际末页。 */
  emptyPage: boolean
  /** 结果是否因最大行数被截断。 */
  truncated: boolean
  /** 本次是否命中缓存（重复翻页、撤回条件、同条件重入都应为 true）。 */
  fromCache: boolean
  /** 本次实际生效的列顺序（同条件重入时保持列顺序）。 */
  fields: string[]
}

/** 报表侧读取的执行状态快照：只含指定批次，不混入其他标签页的中间结果。 */
export interface QueryStatus {
  batchId: string
  ownerSession: string
  status: BatchStatus
  dataset: string
  startedAt: number
  finishedAt: number | null
  /** 该批次已经完整提交的页码（running 时也只暴露完整页）。 */
  committedPages: number[]
  total: number | null
  totalPages: number | null
  message: string
}

/** 已保存的查询结果：只允许保存已完成批次。 */
export interface SavedResult {
  savedId: string
  batchId: string
  sessionId: string
  dataset: string
  savedAt: number
  condition: QueryCondition
  total: number
  totalPages: number
  truncated: boolean
  fields: string[]
  pages: Record<number, DatasetRow[]>
}

/** 缓存条目：同一缓存键下累积完整批次产出的页面，撤回条件时直接复用。 */
export interface CacheEntry {
  cacheKey: string
  datasetVersion: number
  condition: QueryCondition
  total: number
  totalPages: number
  truncated: boolean
  fields: string[]
  pages: Record<number, DatasetRow[]>
  createdAt: number
  lastHitAt: number
  hits: number
}
