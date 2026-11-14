import { QUERY_RULES } from '@/query-engine'
import type { QueryCondition } from '@/query-engine'

/** 表单态：所有输入都是字符串，参数未填完整时保留草稿而不强行转数字。 */
export interface ConditionForm {
  dataset: string
  filter: string
  fieldsText: string
  sortField: string
  sortOrder: 'asc' | 'desc'
  pageSize: string
  maxRows: string
  timeoutSec: string
}

export function defaultForm(): ConditionForm {
  return {
    dataset: 'sales_orders',
    filter: '',
    fieldsText: 'id,region,category,amount',
    sortField: 'id',
    sortOrder: 'asc',
    pageSize: '20',
    maxRows: '1000',
    timeoutSec: '5',
  }
}

export function formToCondition(form: ConditionForm): QueryCondition {
  return {
    dataset: form.dataset,
    filter: form.filter,
    fields: form.fieldsText
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field !== ''),
    sortField: form.sortField,
    sortOrder: form.sortOrder,
    pageSize: Number(form.pageSize),
    maxRows: Number(form.maxRows),
    timeoutSec: Number(form.timeoutSec),
  }
}

export const RULE_HINTS = {
  pageSize: `分页大小范围 ${QUERY_RULES.pageSize.min}-${QUERY_RULES.pageSize.max}`,
  maxRows: `最大行数范围 ${QUERY_RULES.maxRows.min}-${QUERY_RULES.maxRows.max}`,
  timeoutSec: `超时秒数范围 ${QUERY_RULES.timeoutSec.min}-${QUERY_RULES.timeoutSec.max}`,
} as const
