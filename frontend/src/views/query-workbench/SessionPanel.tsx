import { useCallback, useEffect, useMemo, useState } from 'react'

import { buildCacheKey, QueryRuleError, QueryTerminatedError, QueryTimeoutError } from '@/query-engine'
import type { QueryPage, QueryStatus, SavedResult } from '@/query-engine'
import { queryEngine } from './engine-singleton'
import { defaultForm, formToCondition, RULE_HINTS, type ConditionForm } from './forms'

interface SessionPanelProps {
  sessionId: string
  sessionName: string
  /** 数据集版本变化时通知面板：刷新后从第一页重新取数。 */
  datasetVersion: number
}

/**
 * 单个标签页（会话）。所有批次调用都带本面板的 sessionId：
 * 报表状态、终止、保存都只能作用于本标签页自己的批次。
 */
export default function SessionPanel({ sessionId, sessionName, datasetVersion }: SessionPanelProps) {
  const [form, setForm] = useState<ConditionForm>(() => defaultForm())
  const [pageNo, setPageNo] = useState(1)
  const [page, setPage] = useState<QueryPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [batches, setBatches] = useState<QueryStatus[]>([])
  const [saved, setSaved] = useState<SavedResult[]>([])
  const [latencyMs, setLatencyMs] = useState(0)
  /** 草稿标记：条件尚未填完整时保留输入，不把上次成功结果当成新条件结果。 */
  const [draftStale, setDraftStale] = useState(false)

  const condition = useMemo(() => formToCondition(form), [form])
  const cacheKey = useMemo(() => {
    try {
      return buildCacheKey(condition)
    } catch {
      return '（条件不完整，暂无缓存键）'
    }
  }, [condition])

  const refreshSidePanels = useCallback(() => {
    setBatches(queryEngine.listBatches(sessionId))
    setSaved(queryEngine.listSavedResults(sessionId))
  }, [sessionId])

  useEffect(() => {
    refreshSidePanels()
  }, [refreshSidePanels, datasetVersion])

  // 数据集刷新后：从第一页重新取数，绝不沿用旧页码。
  useEffect(() => {
    setPageNo(1)
    setPage(null)
    setNotice(`目标数据集已刷新到版本 ${datasetVersion}，已回到第一页重新取数`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetVersion])

  const loadPage = useCallback(
    async (targetPage: number) => {
      const nextCondition = formToCondition(form)
      const validation = queryEngine.validate(nextCondition)
      if (!validation.valid) {
        // 参数未填完整 / 越界 / 重复参数：保留当前草稿输入，不动已有结果。
        setValidationErrors(validation.issues.map((item) => item.message))
        setDraftStale(true)
        setError('')
        setPage(null)
        return
      }
      setValidationErrors([])
      setDraftStale(false)
      setLoading(true)
      setError('')
      setNotice('')
      try {
        const result = await queryEngine.fetchPage(sessionId, nextCondition, targetPage, {
          latencyMs,
        })
        setPage(result)
        // 越界页码由引擎纠正到实际末页：界面页码同步，继续浏览不会再越界。
        if (result.page !== targetPage) {
          setPageNo(result.page)
          setNotice(`第 ${targetPage} 页超出末页，已回到实际末页第 ${result.page} 页`)
        }
      } catch (reason) {
        if (reason instanceof QueryTimeoutError) {
          // 超时后恢复原页码；缓存未写入，重试会产生新的完整批次。
          setPageNo(reason.requestedPage)
          setError(`${reason.message}。点击「取当前页」可重试新的完整批次`)
        } else if (reason instanceof QueryTerminatedError) {
          setError(`${reason.message}，不提供半页数据`)
          setPage(null)
        } else if (reason instanceof QueryRuleError) {
          setValidationErrors(reason.issues.map((item) => item.message))
          setDraftStale(true)
        } else {
          setError(reason instanceof Error ? reason.message : '取数失败')
        }
      } finally {
        setLoading(false)
        refreshSidePanels()
      }
    },
    [form, latencyMs, refreshSidePanels, sessionId],
  )

  // 在途批次可能被另一处终止：轮询刷新批次面板，让 running 状态及时消失。
  useEffect(() => {
    if (!loading) {
      return
    }
    const timer = window.setInterval(refreshSidePanels, 200)
    return () => window.clearInterval(timer)
  }, [loading, refreshSidePanels])

  function updateForm(patch: Partial<ConditionForm>) {
    setForm((prev) => ({ ...prev, ...patch }))
    setDraftStale(true)
  }

  function moveField(index: number, direction: -1 | 1) {
    const fields = form.fieldsText.split(',').map((item) => item.trim()).filter(Boolean)
    const target = index + direction
    if (target < 0 || target >= fields.length) {
      return
    }
    const next = [...fields]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    updateForm({ fieldsText: next.join(',') })
  }

  function handleTerminate() {
    const running = queryEngine.findRunningBatch(sessionId)
    if (!running) {
      setError('当前标签页没有执行中的批次')
      return
    }
    const status = queryEngine.terminateBatch(sessionId, running.batchId)
    setNotice(`批次 ${status.batchId} 已终止，不会提交半页数据`)
    refreshSidePanels()
  }

  function handleSave() {
    try {
      const record = queryEngine.saveByCondition(sessionId, condition)
      setNotice(`结果已保存（编号 ${record.savedId}），仅含已完整提交的 ${Object.keys(record.pages).length} 个页面`)
      refreshSidePanels()
    } catch (reason) {
      setError(
        reason instanceof QueryTerminatedError
          ? '只有已完成批次可以保存，终止中/超时批次没有半页数据可存'
          : (reason as Error).message,
      )
    }
  }

  const fields = useMemo(
    () => form.fieldsText.split(',').map((item) => item.trim()).filter(Boolean),
    [form.fieldsText],
  )

  return (
    <article className="session-panel" data-session={sessionId}>
      <header className="session-head">
        <h3>{sessionName}</h3>
        <span className="session-id">会话标识：{sessionId}</span>
      </header>

      <div className="form-grid">
        <label className="form-item">
          <span>目标数据集</span>
          <input value={form.dataset} onChange={(event) => updateForm({ dataset: event.target.value })} />
        </label>
        <label className="form-item">
          <span>过滤表达式（; 分隔，= 等值 / ~ 包含）</span>
          <input
            value={form.filter}
            placeholder="如 region=华东;category~电子"
            onChange={(event) => updateForm({ filter: event.target.value })}
          />
        </label>
        <label className="form-item">
          <span>返回字段（英文逗号分隔，顺序即列顺序）</span>
          <input value={form.fieldsText} onChange={(event) => updateForm({ fieldsText: event.target.value })} />
        </label>
        <div className="form-item">
          <span>字段顺序调整（切换顺序缓存键随之变化）</span>
          <div className="field-order-list">
            {fields.map((field, index) => (
              <span key={`${field}-${index}`} className="field-chip">
                {field}
                <button type="button" className="link" onClick={() => moveField(index, -1)}>←</button>
                <button type="button" className="link" onClick={() => moveField(index, 1)}>→</button>
              </span>
            ))}
          </div>
        </div>
        <label className="form-item">
          <span>排序字段</span>
          <input value={form.sortField} onChange={(event) => updateForm({ sortField: event.target.value })} />
        </label>
        <label className="form-item">
          <span>排序方向</span>
          <select
            value={form.sortOrder}
            onChange={(event) => updateForm({ sortOrder: event.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">升序 asc</option>
            <option value="desc">降序 desc</option>
          </select>
        </label>
        <label className="form-item">
          <span>分页大小（{RULE_HINTS.pageSize}）</span>
          <input value={form.pageSize} onChange={(event) => updateForm({ pageSize: event.target.value })} />
        </label>
        <label className="form-item">
          <span>最大行数（{RULE_HINTS.maxRows}）</span>
          <input value={form.maxRows} onChange={(event) => updateForm({ maxRows: event.target.value })} />
        </label>
        <label className="form-item">
          <span>超时秒数（{RULE_HINTS.timeoutSec}）</span>
          <input value={form.timeoutSec} onChange={(event) => updateForm({ timeoutSec: event.target.value })} />
        </label>
        <label className="form-item">
          <span>模拟执行耗时毫秒（超过超时秒数即触发超时）</span>
          <input
            type="number"
            value={latencyMs}
            onChange={(event) => setLatencyMs(Number(event.target.value))}
          />
        </label>
      </div>

      {validationErrors.length > 0 && (
        <div className="alert alert-warn">
          <strong>规则拒绝（草稿输入已保留）：</strong>
          <ul>
            {validationErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {draftStale && validationErrors.length === 0 && (
        <p className="hint">条件已修改且尚未成功取数：当前展示的仍是上一次完整结果，不会被当成新条件的结果。</p>
      )}
      {notice && <div className="alert alert-info">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="action-row">
        <button className="btn primary" type="button" disabled={loading} onClick={() => loadPage(pageNo)}>
          {loading ? '取数中…' : '取当前页'}
        </button>
        <button className="btn" type="button" onClick={handleTerminate} disabled={!loading}>
          终止查询
        </button>
        <button className="btn" type="button" onClick={handleSave}>
          保存已完成批次
        </button>
      </div>

      <div className="pager">
        <button className="btn" type="button" disabled={loading || pageNo <= 1} onClick={() => {
          const next = Math.max(1, pageNo - 1)
          setPageNo(next)
          void loadPage(next)
        }}>
          上一页
        </button>
        <span>
          第 <strong>{pageNo}</strong> 页 / 共 {page ? page.totalPages : '—'} 页
          {page && page.emptyPage && <em className="badge badge-warn">空页已纠正到末页</em>}
          {page && page.zeroRows && <em className="badge badge-muted">零行结果</em>}
          {page && page.truncated && <em className="badge badge-warn">已按最大行数截断</em>}
          {page && page.fromCache && <em className="badge badge-ok">缓存命中</em>}
        </span>
        <button className="btn" type="button" disabled={loading || (page !== null && pageNo >= page.totalPages)} onClick={() => {
          const next = pageNo + 1
          setPageNo(next)
          void loadPage(next)
        }}>
          下一页
        </button>
        <label className="jump-page">
          跳页
          <input
            type="number"
            min={1}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const target = Number((event.target as HTMLInputElement).value)
                if (Number.isInteger(target) && target >= 1) {
                  setPageNo(target)
                  void loadPage(target)
                }
              }
            }}
          />
        </label>
      </div>

      <div className="result-meta">
        <span>缓存键：<code>{cacheKey}</code></span>
        {page && (
          <span>
            批次 {page.batchId} ｜ 窗口 {page.items.length} 行 ｜ 总数 {page.total}（同一规则计算）｜ 数据集版本 v{datasetVersion}
          </span>
        )}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {(page?.fields ?? fields).map((field) => (
                <th key={field}>{field}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.map((row, rowIndex) => (
              <tr key={`${row.id ?? rowIndex}-${rowIndex}`}>
                {(page.fields ?? fields).map((field) => (
                  <td key={field}>{String(row[field] ?? '—')}</td>
                ))}
              </tr>
            ))}
            {page && page.zeroRows && (
              <tr>
                <td className="empty-state" colSpan={Math.max(1, page.fields.length)}>
                  零行：过滤后命中 0 条（与越界空页含义不同）
                </td>
              </tr>
            )}
            {!page && pageNo === 1 && validationErrors.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={Math.max(1, fields.length)}>尚未取数，填写条件后点击「取当前页」</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="side-lists">
        <section className="side-block">
          <h4>本标签页批次（报表状态，只含完整提交页）</h4>
          <ul className="batch-list">
            {batches.map((batch) => (
              <li key={batch.batchId}>
                <code>{batch.batchId}</code>
                <span className={`status-pill status-${batch.status}`}>{statusLabel(batch.status)}</span>
                <span>已提交页 {batch.committedPages.length === 0 ? '无' : batch.committedPages.join(',')}</span>
                <span className="muted">{batch.message}</span>
              </li>
            ))}
            {batches.length === 0 && <li className="muted">暂无批次</li>}
          </ul>
        </section>
        <section className="side-block">
          <h4>已保存结果（仅限已完成批次）</h4>
          <ul className="batch-list">
            {saved.map((item) => (
              <li key={item.savedId}>
                <code>{item.savedId}</code>
                <span>{item.dataset}</span>
                <span>总数 {item.total} ｜ 保存 {Object.keys(item.pages).length} 页</span>
              </li>
            ))}
            {saved.length === 0 && <li className="muted">暂无保存记录</li>}
          </ul>
        </section>
      </div>
    </article>
  )
}

function statusLabel(status: QueryStatus['status']): string {
  const labels: Record<QueryStatus['status'], string> = {
    running: '执行中',
    complete: '已完成',
    timeout: '已超时',
    terminated: '已终止',
  }
  return labels[status]
}
