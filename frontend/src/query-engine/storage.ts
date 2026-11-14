import type { SavedResult } from './types'

/**
 * 已保存查询结果的本地持久化。
 * 只有「已完成批次」允许写入；终止中/超时批次在引擎层就被拒绝，到不了这里。
 */
const STORAGE_KEY = 'interactive-analytics-lab:query-saved-results'

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

export function loadSavedResults(): SavedResult[] {
  if (!canUseStorage()) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as SavedResult[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function persistSavedResults(results: SavedResult[]): void {
  if (!canUseStorage()) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(results))
}
