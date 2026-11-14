import type { QueryCondition } from './types'

/**
 * 缓存键规则（对应需求中的多条约束）：
 * 1. 返回字段按「数组顺序」参与键计算，切换字段顺序 => 键变化；
 * 2. 最大行数、超时秒数参与键，不同限制不能共享同一份（可能被截断的）结果；
 * 3. 目标数据集、过滤条件、排序字段/方向、分页大小都参与键；
 * 4. 规范化序列化保证重复参数给出一致判定（同条件永远得到同一个键）。
 *
 * 数据刷新（数据集版本变化）不写进键里，而在命中时用版本号比对失效，
 * 这样刷新后同条件会重新从第一页取数，而不是读到旧页码对应的旧结果。
 */
export function buildCacheKey(condition: QueryCondition): string {
  const normalized = {
    dataset: condition.dataset.trim(),
    filter: condition.filter.trim(),
    // 字段保留顺序、逐字段去空白；重复字段按重复参数在 validate 里拒绝，这里先稳定序列化。
    fields: condition.fields.map((field) => field.trim()).filter((field) => field !== ''),
    sortField: condition.sortField.trim(),
    sortOrder: condition.sortOrder,
    pageSize: condition.pageSize,
    maxRows: condition.maxRows,
    timeoutSec: condition.timeoutSec,
  }
  // 不用 JSON.stringify 直接拼对象——键名固定后再串，字段顺序本身由数组承载，避免对象键序歧义。
  const parts = [
    `dataset=${normalized.dataset}`,
    `filter=${normalized.filter}`,
    `fields=${normalized.fields.map((field) => encodeURIComponent(field)).join('>')}`,
    `sort=${normalized.sortField}:${normalized.sortOrder}`,
    `pageSize=${normalized.pageSize}`,
    `maxRows=${normalized.maxRows}`,
    `timeoutSec=${normalized.timeoutSec}`,
  ]
  return `qcache:${parts.join('|')}`
}
