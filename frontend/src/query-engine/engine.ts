import { buildCacheKey } from './cache-key'
import { clampPage, LocalDataset, pageWindow, prepareQuery } from './dataset'
import { BatchOwnershipError, QueryRuleError, QueryTerminatedError, QueryTimeoutError } from './errors'
import { loadSavedResults, persistSavedResults } from './storage'
import type {
  BatchStatus,
  CacheEntry,
  DatasetRow,
  QueryCondition,
  QueryPage,
  QueryStatus,
  SavedResult,
  ValidationResult,
} from './types'
import { isConditionComplete, validateCondition } from './validation'

/** 可注入时钟与调度器：测试用手动时钟模拟超时，界面用真实定时器。 */
export interface EngineClock {
  now(): number
  delay(ms: number): Promise<void>
}

export const realClock: EngineClock = {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

interface BatchRecord {
  batchId: string
  ownerSession: string
  cacheKey: string
  status: BatchStatus
  dataset: string
  startedAt: number
  finishedAt: number | null
  committedPages: number[]
  total: number | null
  totalPages: number | null
  message: string
}

interface FetchOptions {
  /** 模拟执行耗时（毫秒）。超过超时秒数对应的预算即触发超时。 */
  latencyMs?: number
}

let engineSequence = 0

/**
 * 查询引擎：承载分页窗口、缓存、批次隔离与执行状态的全部规则。
 * 一个实例对应一个工作台；多标签页通过不同 sessionId 在同一引擎内隔离批次。
 */
export class QueryEngine {
  private readonly batches = new Map<string, BatchRecord>()
  private readonly cache = new Map<string, CacheEntry>()
  /** 缓存键 => 最近一个产出该缓存的已完成批次，供缓存命中后的保存动作反查。 */
  private readonly batchByCacheKey = new Map<string, string>()
  /** 在途请求去重：同缓存键同页码的重复翻页请求共用同一个 Promise，不追加重复行。 */
  private readonly inFlight = new Map<string, Promise<QueryPage>>()
  private readonly dataset: LocalDataset
  private readonly clock: EngineClock
  private saved: SavedResult[]

  constructor(dataset?: LocalDataset, clock: EngineClock = realClock) {
    this.dataset = dataset ?? new LocalDataset()
    this.clock = clock
    this.saved = loadSavedResults()
  }

  get datasetName(): string {
    return this.dataset.name
  }

  get datasetVersion(): number {
    return this.dataset.currentVersion
  }

  datasetFields(): string[] {
    return this.dataset.snapshot().fields
  }

  /** 校验但不执行：界面在提交前与引擎内部共用同一套规则判定。 */
  validate(condition: QueryCondition): ValidationResult {
    return validateCondition(condition, this.datasetFields())
  }

  /**
   * 取一页数据。
   * 规则落点：
   * - 未填完整 => QueryRuleError，不读不写缓存，界面保留草稿；
   * - 只返回当前页窗口，total 按同一套过滤/排序/截断规则计算；
   * - 越界页码纠正到实际末页（emptyPage=true）；零行（zeroRows=true）与空页区分；
   * - 缓存命中（撤回条件、重复翻页、同条件重入）不产生新批次；
   * - 超时 => QueryTimeoutError，批次记 timeout，不写缓存，可重试新批次；
   * - 同键同页并发 => 合并为同一个 Promise。
   */
  fetchPage(
    sessionId: string,
    condition: QueryCondition,
    requestedPage: number,
    options: FetchOptions = {},
  ): Promise<QueryPage> {
    const validation = this.validate(condition)
    if (!validation.valid || !isConditionComplete(condition)) {
      // 规则拒绝不产生任何副作用：上一次成功结果不会被当成新条件的结果。
      return Promise.reject(new QueryRuleError(validation.issues))
    }

    const cacheKey = buildCacheKey(condition)
    const flightKey = `${sessionId}::${cacheKey}::${requestedPage}`
    const pending = this.inFlight.get(flightKey)
    if (pending) {
      return pending
    }

    const task = this.executePage(sessionId, condition, cacheKey, requestedPage, options)
      .finally(() => {
        this.inFlight.delete(flightKey)
      })
    this.inFlight.set(flightKey, task)
    return task
  }

  private async executePage(
    sessionId: string,
    condition: QueryCondition,
    cacheKey: string,
    requestedPage: number,
    options: FetchOptions,
  ): Promise<QueryPage> {
    const snapshot = this.dataset.snapshot()
    const existing = this.cache.get(cacheKey)
    const cacheValid = existing !== undefined && existing.datasetVersion === snapshot.version
    const latency = options.latencyMs ?? 0

    if (cacheValid && existing) {
      // 命中缓存：重复翻页、撤回条件沿用最近一次完整结果、同条件重入保持列顺序。
      if (latency > 0) {
        await this.clock.delay(Math.min(latency, 5))
      }
      return this.readFromCache(sessionId, existing, requestedPage)
    }

    // 缓存未命中（含数据集刷新导致的版本失效）：开启一个新的完整批次，从本次请求页开始产出。
    const batch = this.createBatch(sessionId, cacheKey, condition.dataset)
    const timeoutMs = condition.timeoutSec * 1000

    if (latency > timeoutMs) {
      await this.clock.delay(timeoutMs)
      batch.status = 'timeout'
      batch.finishedAt = this.clock.now()
      batch.message = `执行超过 ${condition.timeoutSec} 秒上限，批次终止，未写入缓存`
      throw new QueryTimeoutError(batch.batchId, requestedPage)
    }
    if (latency > 0) {
      await this.clock.delay(latency)
    }
    if (batch.status === 'terminated') {
      // 终止与超时竞态时终止优先，且不提交半页数据。
      throw new QueryTerminatedError(batch.batchId)
    }

    const prepared = prepareQuery(snapshot, condition)
    const totalPages = prepared.total === 0 ? 0 : Math.ceil(prepared.total / condition.pageSize)
    const actualPage = clampPage(requestedPage, totalPages)
    const items = totalPages === 0 ? [] : pageWindow(prepared.rows, actualPage, condition.pageSize)

    // 仅在成功取页后写缓存，且只提交当前页窗口；后续页由各自请求补入同一缓存条目。
    // 旧版本条目（数据集刷新后残留）在此被整体替换：刷新后不允许把旧页码对应到旧数据。
    const entry: CacheEntry = {
      cacheKey,
      datasetVersion: snapshot.version,
      condition: cloneCondition(condition),
      total: prepared.total,
      totalPages,
      truncated: prepared.truncated,
      fields: [...condition.fields.map((field) => field.trim()).filter(Boolean)],
      pages: { [actualPage]: items },
      createdAt: this.clock.now(),
      lastHitAt: this.clock.now(),
      hits: 0,
    }
    this.cache.set(cacheKey, entry)

    batch.status = 'complete'
    batch.finishedAt = this.clock.now()
    batch.committedPages = [actualPage]
    batch.total = prepared.total
    batch.totalPages = totalPages
    batch.message = '批次完成，当前页已完整提交'
    this.batchByCacheKey.set(cacheKey, batch.batchId)

    return this.buildPageResult(batch.batchId, entry, actualPage, requestedPage, items, false)
  }

  private readFromCache(sessionId: string, entry: CacheEntry, requestedPage: number): QueryPage {
    const actualPage = clampPage(requestedPage, entry.totalPages)
    entry.lastHitAt = this.clock.now()
    entry.hits += 1
    const cachedItems = entry.pages[actualPage]
    if (cachedItems === undefined) {
      // 缓存条目存在但该窗口尚未取过：补取该页并写回同一批次来源的缓存条目。
      const snapshot = this.dataset.snapshot()
      const prepared = prepareQuery(snapshot, entry.condition)
      const items = entry.totalPages === 0 ? [] : pageWindow(prepared.rows, actualPage, entry.condition.pageSize)
      entry.pages[actualPage] = items
      // 同步登记到来源批次的完整提交页码；只有批次属主会话才能推进它的提交状态。
      const sourceBatchId = this.batchByCacheKey.get(entry.cacheKey)
      const sourceBatch = sourceBatchId ? this.batches.get(sourceBatchId) : undefined
      if (sourceBatch && sourceBatch.ownerSession === sessionId && !sourceBatch.committedPages.includes(actualPage)) {
        sourceBatch.committedPages = [...sourceBatch.committedPages, actualPage].sort((a, b) => a - b)
      }
      return this.buildPageResult(
        `cache:${entry.cacheKey}`,
        entry,
        actualPage,
        requestedPage,
        items,
        true,
      )
    }
    return this.buildPageResult(
      `cache:${entry.cacheKey}`,
      entry,
      actualPage,
      requestedPage,
      cachedItems,
      true,
    )
  }

  private buildPageResult(
    batchId: string,
    entry: CacheEntry,
    page: number,
    requestedPage: number,
    items: DatasetRow[],
    fromCache: boolean,
  ): QueryPage {
    return {
      batchId,
      page,
      requestedPage,
      size: entry.condition.pageSize,
      items: items.map((row) => ({ ...row })),
      total: entry.total,
      totalPages: entry.totalPages,
      // 零行：命中总数为 0；空页：总数大于 0 但请求页越界被纠正。
      zeroRows: entry.total === 0,
      emptyPage: requestedPage !== page && entry.total > 0,
      truncated: entry.truncated,
      fromCache,
      fields: [...entry.fields],
    }
  }

  private createBatch(sessionId: string, cacheKey: string, dataset: string): BatchRecord {
    engineSequence += 1
    const batch: BatchRecord = {
      batchId: `B${this.clock.now().toString(36)}-${engineSequence}`,
      ownerSession: sessionId,
      cacheKey,
      status: 'running',
      dataset,
      startedAt: this.clock.now(),
      finishedAt: null,
      committedPages: [],
      total: null,
      totalPages: null,
      message: '批次执行中',
    }
    this.batches.set(batch.batchId, batch)
    return batch
  }

  /**
   * 终止执行中的批次。
   * 终止是同步落状态的：不存在「终止中」中间态，终止后不提供半页数据。
   */
  terminateBatch(sessionId: string, batchId: string): QueryStatus {
    const batch = this.requireOwnedBatch(sessionId, batchId)
    if (batch.status === 'running') {
      batch.status = 'terminated'
      batch.finishedAt = this.clock.now()
      batch.message = '批次被值班员终止，未提交页面数据'
    }
    return this.toStatus(batch)
  }

  /**
   * 报表侧读取执行状态：只能拿到指定标签页自己的批次，
   * 且只暴露完整提交过的页码，读不到另一标签页尚未提交的中间结果。
   */
  getStatus(sessionId: string, batchId: string): QueryStatus {
    return this.toStatus(this.requireOwnedBatch(sessionId, batchId))
  }

  /** 列出当前标签页的批次（按开始时间倒序），其他标签页批次不可见。 */
  listBatches(sessionId: string): QueryStatus[] {
    return [...this.batches.values()]
      .filter((batch) => batch.ownerSession === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((batch) => this.toStatus(batch))
  }

  /** 找当前标签页仍在执行中的批次：终止动作只针对在途批次，且不跨标签页。 */
  findRunningBatch(sessionId: string): QueryStatus | null {
    const found = [...this.batches.values()].find(
      (batch) => batch.ownerSession === sessionId && batch.status === 'running',
    )
    return found ? this.toStatus(found) : null
  }

  /**
   * 保存查询结果：只保存已完成批次；执行中/终止/超时批次一律拒绝。
   * 保存内容是该缓存条目下已完整提交的页面，终止中的查询无法保存半页数据。
   */
  saveResult(sessionId: string, batchId: string): SavedResult {
    const batch = this.requireOwnedBatch(sessionId, batchId)
    if (batch.status !== 'complete') {
      throw new QueryTerminatedError(
        batch.batchId,
      )
    }
    const entry = this.cache.get(batch.cacheKey)
    if (!entry || Object.keys(entry.pages).length === 0) {
      throw new QueryTerminatedError(batch.batchId)
    }
    const savedId = `S${this.clock.now().toString(36)}-${this.saved.length + 1}`
    const savedResult: SavedResult = {
      savedId,
      batchId: batch.batchId,
      sessionId,
      dataset: entry.condition.dataset,
      savedAt: this.clock.now(),
      condition: cloneCondition(entry.condition),
      total: entry.total,
      totalPages: entry.totalPages,
      truncated: entry.truncated,
      fields: [...entry.fields],
      pages: Object.fromEntries(
        Object.entries(entry.pages).map(([page, rows]) => [page, rows.map((row) => ({ ...row }))]),
      ),
    }
    this.saved = [...this.saved, savedResult]
    persistSavedResults(this.saved)
    return savedResult
  }

  /**
   * 按展示条件保存：翻到后续页时请求命中缓存（batchId 为 cache: 前缀），
   * 这里反查产出该缓存的真实已完成批次；批次不属于当前标签页则按归属规则拒绝。
   */
  saveByCondition(sessionId: string, condition: QueryCondition): SavedResult {
    const cacheKey = buildCacheKey(condition)
    const batchId = this.batchByCacheKey.get(cacheKey)
    if (!batchId) {
      throw new QueryRuleError([
        { field: 'params', message: '该条件还没有成功完成的批次，无法保存结果' },
      ])
    }
    return this.saveResult(sessionId, batchId)
  }

  listSavedResults(sessionId?: string): SavedResult[] {
    return sessionId
      ? this.saved.filter((item) => item.sessionId === sessionId)
      : [...this.saved]
  }

  /** 缓存观察面板用：返回当前全部缓存条目快照。 */
  inspectCache(): CacheEntry[] {
    return [...this.cache.values()].map((entry) => ({
      ...entry,
      condition: cloneCondition(entry.condition),
      fields: [...entry.fields],
      pages: Object.fromEntries(
        Object.entries(entry.pages).map(([page, rows]) => [page, rows.map((row) => ({ ...row }))]),
      ),
    }))
  }

  /** 数据集刷新：版本号前进，所有缓存条目在下一次访问时按版本失效，取数从第一页重新开始。 */
  refreshDataset(): number {
    const snapshot = this.dataset.refresh()
    return snapshot.version
  }

  private requireOwnedBatch(sessionId: string, batchId: string): BatchRecord {
    const batch = this.batches.get(batchId)
    if (!batch || batch.ownerSession !== sessionId) {
      throw new BatchOwnershipError(batchId)
    }
    return batch
  }

  private toStatus(batch: BatchRecord): QueryStatus {
    return {
      batchId: batch.batchId,
      ownerSession: batch.ownerSession,
      status: batch.status,
      dataset: batch.dataset,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      committedPages: [...batch.committedPages],
      total: batch.total,
      totalPages: batch.totalPages,
      message: batch.message,
    }
  }
}

function cloneCondition(condition: QueryCondition): QueryCondition {
  return {
    ...condition,
    fields: [...condition.fields],
  }
}
