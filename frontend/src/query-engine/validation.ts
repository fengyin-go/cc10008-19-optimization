import type { QueryCondition, ValidationIssue, ValidationResult } from './types'

/**
 * 查询规则：分页上限与超时阈值都在这里集中定义，引擎与界面共用同一份判定。
 * 超出范围按标准拒绝；同一组参数无论提交多少次，结论一致（纯函数）。
 */
export const QUERY_RULES = {
  pageSize: { min: 1, max: 100 },
  maxRows: { min: 1, max: 10000 },
  timeoutSec: { min: 1, max: 300 },
  filterMaxLength: 500,
  maxFieldCount: 20,
} as const

function issue(field: ValidationIssue['field'], message: string): ValidationIssue {
  return { field, message }
}

/**
 * 校验查询条件。
 * - 参数未填完整 => invalid，调用方保留草稿输入，且不得把上一次成功结果当作新条件结果；
 * - 分页上限、超时阈值越界 => 按标准拒绝，给出字段级原因；
 * - 重复参数（重复返回字段）=> 一致判定为拒绝。
 */
export function validateCondition(
  condition: QueryCondition,
  knownFields: readonly string[] = [],
): ValidationResult {
  const issues: ValidationIssue[] = []

  if (condition.dataset.trim() === '') {
    issues.push(issue('dataset', '目标数据集尚未填写完整'))
  }
  if (condition.sortField.trim() === '') {
    issues.push(issue('sortField', '排序字段尚未填写完整'))
  }
  if (condition.filter.trim().length > QUERY_RULES.filterMaxLength) {
    issues.push(issue('filter', `过滤表达式长度不能超过 ${QUERY_RULES.filterMaxLength} 个字符`))
  }

  const trimmedFields = condition.fields.map((field) => field.trim())
  if (trimmedFields.some((field) => field === '')) {
    issues.push(issue('fields', '返回字段中存在未填写完整的空字段'))
  }
  if (trimmedFields.filter((field) => field !== '').length === 0) {
    issues.push(issue('fields', '至少选择一个返回字段'))
  }
  if (trimmedFields.length > QUERY_RULES.maxFieldCount) {
    issues.push(issue('fields', `返回字段数量不能超过 ${QUERY_RULES.maxFieldCount} 个`))
  }
  // 重复参数给一致判定：同名字段出现两次即拒绝，避免列含义歧义。
  const seen = new Set<string>()
  for (const field of trimmedFields) {
    if (field === '') {
      continue
    }
    if (seen.has(field)) {
      issues.push(issue('fields', `返回字段「${field}」重复，重复参数不允许提交`))
    }
    seen.add(field)
  }
  if (knownFields.length > 0) {
    for (const field of trimmedFields) {
      if (field !== '' && !knownFields.includes(field)) {
        issues.push(issue('fields', `返回字段「${field}」不在数据集字段清单内`))
      }
    }
    if (condition.sortField.trim() !== '' && !knownFields.includes(condition.sortField.trim())) {
      issues.push(issue('sortField', `排序字段「${condition.sortField}」不在数据集字段清单内`))
    }
  }

  if (
    !Number.isInteger(condition.pageSize) ||
    condition.pageSize < QUERY_RULES.pageSize.min ||
    condition.pageSize > QUERY_RULES.pageSize.max
  ) {
    issues.push(
      issue(
        'pageSize',
        `分页大小必须是 ${QUERY_RULES.pageSize.min}-${QUERY_RULES.pageSize.max} 之间的整数`,
      ),
    )
  }
  if (
    !Number.isInteger(condition.maxRows) ||
    condition.maxRows < QUERY_RULES.maxRows.min ||
    condition.maxRows > QUERY_RULES.maxRows.max
  ) {
    issues.push(
      issue(
        'maxRows',
        `最大行数必须是 ${QUERY_RULES.maxRows.min}-${QUERY_RULES.maxRows.max} 之间的整数`,
      ),
    )
  }
  if (
    !Number.isInteger(condition.timeoutSec) ||
    condition.timeoutSec < QUERY_RULES.timeoutSec.min ||
    condition.timeoutSec > QUERY_RULES.timeoutSec.max
  ) {
    issues.push(
      issue(
        'timeoutSec',
        `超时秒数必须是 ${QUERY_RULES.timeoutSec.min}-${QUERY_RULES.timeoutSec.max} 之间的整数`,
      ),
    )
  }
  if (condition.sortOrder !== 'asc' && condition.sortOrder !== 'desc') {
    issues.push(issue('sortOrder', '排序方向只允许 asc 或 desc'))
  }

  return { valid: issues.length === 0, issues }
}

/** 条件是否填写完整：不完整时只保留草稿，不触发取数。 */
export function isConditionComplete(condition: QueryCondition): boolean {
  return (
    condition.dataset.trim() !== '' &&
    condition.sortField.trim() !== '' &&
    condition.fields.some((field) => field.trim() !== '')
  )
}
