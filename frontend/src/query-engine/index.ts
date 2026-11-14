export { QueryEngine, realClock } from './engine'
export type { EngineClock } from './engine'
export { buildCacheKey } from './cache-key'
export { QUERY_RULES, isConditionComplete, validateCondition } from './validation'
export { LocalDataset, clampPage, pageWindow, prepareQuery } from './dataset'
export type { DatasetSnapshot } from './dataset'
export {
  BatchOwnershipError,
  QueryEngineError,
  QueryRuleError,
  QueryTerminatedError,
  QueryTimeoutError,
} from './errors'
export type {
  BatchStatus,
  CacheEntry,
  DatasetRow,
  QueryCondition,
  QueryPage,
  QueryStatus,
  SavedResult,
  ValidationIssue,
  ValidationResult,
} from './types'
