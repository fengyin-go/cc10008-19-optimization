import { useCallback, useEffect, useState } from 'react'

import type { CacheEntry } from '@/query-engine'
import { queryEngine } from './engine-singleton'
import SessionPanel from './SessionPanel'

/**
 * 查询工作台：两个标签页共用引擎、隔离批次；下方缓存观察面板展示全部缓存条目，
 * 便于验证字段顺序、最大行数、超时秒数变化时缓存键的差异与刷新失效行为。
 */
export default function QueryWorkbench() {
  const [datasetVersion, setDatasetVersion] = useState(() => queryEngine.datasetVersion)
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([])
  const [tick, setTick] = useState(0)

  const refreshCache = useCallback(() => {
    setCacheEntries(queryEngine.inspectCache())
  }, [])

  useEffect(() => {
    refreshCache()
  }, [refreshCache, tick, datasetVersion])

  // 取数/终止等动作发生在子面板内，这里用轻量轮询保持观察面板与版本号同步。
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((value) => value + 1)
      setDatasetVersion(queryEngine.datasetVersion)
    }, 800)
    return () => window.clearInterval(timer)
  }, [])

  function handleRefresh() {
    const version = queryEngine.refreshDataset()
    setDatasetVersion(version)
    setCacheEntries(queryEngine.inspectCache())
  }

  return (
    <section className="page workbench" data-module="query-workbench">
      <header className="page-head">
        <div>
          <h2>查询工作台（分页窗口 · 缓存键 · 批次隔离）</h2>
          <p className="page-desc">
            两个标签页模拟并行值班会话：响应只取当前页窗口、总数按同一规则计算；数据刷新回第一页，
            旧页码回到可浏览末页；字段顺序、最大行数、超时秒数都参与缓存键；报表状态按标签页批次隔离。
          </p>
        </div>
        <div className="page-actions">
          <span className="version-tag">数据集 {queryEngine.datasetName} · 版本 v{datasetVersion}</span>
          <button className="btn primary" type="button" onClick={handleRefresh}>
            刷新数据集（全部标签页回第一页）
          </button>
        </div>
      </header>

      <div className="session-grid">
        <SessionPanel sessionId="tab-alpha" sessionName="标签页 A" datasetVersion={datasetVersion} />
        <SessionPanel sessionId="tab-beta" sessionName="标签页 B" datasetVersion={datasetVersion} />
      </div>

      <section className="cache-inspector">
        <header className="inspector-head">
          <h3>缓存观察面板（共 {cacheEntries.length} 条）</h3>
          <button className="btn ghost" type="button" onClick={refreshCache}>
            刷新观察
          </button>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>缓存键</th>
              <th>数据集版本</th>
              <th>列顺序</th>
              <th>总数 / 页数</th>
              <th>已缓存窗口</th>
              <th>截断</th>
              <th>命中次数</th>
            </tr>
          </thead>
          <tbody>
            {cacheEntries.map((entry) => (
              <tr key={entry.cacheKey}>
                <td><code className="cache-key-cell">{entry.cacheKey}</code></td>
                <td>v{entry.datasetVersion}</td>
                <td>{entry.fields.join(' → ')}</td>
                <td>{entry.total} / {entry.totalPages}</td>
                <td>{Object.keys(entry.pages).map(Number).sort((a, b) => a - b).join(', ') || '—'}</td>
                <td>{entry.truncated ? '是' : '否'}</td>
                <td>{entry.hits}</td>
              </tr>
            ))}
            {cacheEntries.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={7}>暂无缓存，任一标签页成功取数后这里会出现条目</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </section>
  )
}
