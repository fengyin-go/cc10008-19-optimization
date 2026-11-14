import type { ValidationIssue } from './types'

/** 引擎错误基类：界面可按类型区分提示与后续动作。 */
export class QueryEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryEngineError'
  }
}

/** 规则拒绝：参数不完整、越界、重复参数等。草稿输入由界面保留，引擎不改任何状态。 */
export class QueryRuleError extends QueryEngineError {
  readonly issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super(issues.map((item) => item.message).join('；'))
    this.name = 'QueryRuleError'
    this.issues = issues
  }
}

/** 执行超时：携带请求页码，界面据此恢复原页码，重试时由引擎另开完整批次。 */
export class QueryTimeoutError extends QueryEngineError {
  readonly batchId: string
  readonly requestedPage: number
  constructor(batchId: string, requestedPage: number) {
    super(`批次 ${batchId} 执行超时，已恢复原页码第 ${requestedPage} 页，可重试新的完整批次`)
    this.name = 'QueryTimeoutError'
    this.batchId = batchId
    this.requestedPage = requestedPage
  }
}

/** 查询被终止：不产出任何半页数据。 */
export class QueryTerminatedError extends QueryEngineError {
  readonly batchId: string
  constructor(batchId: string) {
    super(`批次 ${batchId} 已被终止，未提交任何页面数据`)
    this.name = 'QueryTerminatedError'
    this.batchId = batchId
  }
}

/** 批次归属校验：一个标签页不能读取另一个标签页批次的中间结果。 */
export class BatchOwnershipError extends QueryEngineError {
  constructor(batchId: string) {
    super(`批次 ${batchId} 不属于当前标签页，禁止读取其执行状态`)
    this.name = 'BatchOwnershipError'
  }
}
