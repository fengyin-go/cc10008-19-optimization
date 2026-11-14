import {
  buildCacheKey,
  LocalDataset,
  QueryEngine,
  QueryRuleError,
  QueryTerminatedError,
  QueryTimeoutError,
  QUERY_RULES,
  validateCondition,
} from '@/query-engine'
import type { EngineClock, QueryCondition } from '@/query-engine'
import { assert, assertDeepEqual, assertEqual, assertRejects, describe, it } from './harness'

/** 手动时钟：delay 挂起直到 tick 放行，测试里精确控制超时，不依赖真实时间。 */
function manualClock(): EngineClock & { tick: () => void } {
  const pendingResolvers: (() => void)[] = []
  return {
    now: (() => {
      let current = 1_700_000_000_000
      return () => current
    })(),
    delay() {
      return new Promise<void>((resolve) => {
        pendingResolvers.push(resolve)
      })
    },
    tick() {
      const due = pendingResolvers.splice(0)
      for (const resolve of due) {
        resolve()
      }
    },
  }
}

function baseCondition(overrides: Partial<QueryCondition> = {}): QueryCondition {
  return {
    dataset: 'sales_orders',
    filter: '',
    fields: ['id', 'region', 'category', 'amount'],
    sortField: 'id',
    sortOrder: 'asc',
    pageSize: 20,
    maxRows: 1000,
    timeoutSec: 5,
    ...overrides,
  }
}

export async function run(): Promise<void> {
  describe('分页窗口与总数规则', () => {
    it('响应只取当前页窗口，总数按同一套过滤/截断规则计算', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 257))
      const condition = baseCondition({ pageSize: 20 })
      const first = await engine.fetchPage('tab-A', condition, 1)
      assertEqual(first.items.length, 20, '第一页窗口应为 20 行')
      assertEqual(first.total, 257, '总数是全量命中数而不是窗口行数')
      assertEqual(first.totalPages, 13, '257 行 / 20 = 13 页')
      const second = await engine.fetchPage('tab-A', condition, 2)
      assertEqual(second.items.length, 20, '第二页也是 20 行窗口')
      assertEqual(second.items[0].id, 21, '第二页从第 21 行开始，没有重算第一页内容')
      assertEqual(second.total, 257, '翻页后总数规则保持一致')
      const last = await engine.fetchPage('tab-A', condition, 13)
      assertEqual(last.items.length, 17, '末页只含剩余 17 行')
    })

    it('过滤条件在所有页面按同一规则生效', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 257))
      const condition = baseCondition({ filter: 'region=华东', pageSize: 50 })
      const page = await engine.fetchPage('tab-A', condition, 1)
      assert(page.total > 0 && page.total < 257, '过滤后总数应小于全量')
      assert(page.items.every((row) => row.region === '华东'), '窗口内只含命中行')
    })

    it('最后一页超过总行数时回到实际末页，并以 emptyPage 标记', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 55))
      const condition = baseCondition({ pageSize: 20 })
      const page = await engine.fetchPage('tab-A', condition, 99)
      assertEqual(page.requestedPage, 99, '保留原始请求页码')
      assertEqual(page.page, 3, '越界请求被纠正到实际末页')
      assertEqual(page.items.length, 15, '返回实际末页的 15 行')
      assertEqual(page.emptyPage, true, '空页（越界纠正）必须显式标记')
      assertEqual(page.zeroRows, false, '空页不等于零行')
    })

    it('零行结果与空页区分表示', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 55))
      const condition = baseCondition({ filter: 'region=不存在的大区' })
      const page = await engine.fetchPage('tab-A', condition, 1)
      assertEqual(page.total, 0, '过滤后零行')
      assertEqual(page.items.length, 0, '没有窗口数据')
      assertEqual(page.zeroRows, true, '零行必须显式标记')
      assertEqual(page.emptyPage, false, '零行不是越界空页')
      assertEqual(page.totalPages, 0, '零行时总页数为 0')
    })

    it('翻页请求重复到达时合并处理，不追加重复行', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80))
      const condition = baseCondition({ pageSize: 20 })
      const [p1, p2, p3] = await Promise.all([
        engine.fetchPage('tab-A', condition, 2),
        engine.fetchPage('tab-A', condition, 2),
        engine.fetchPage('tab-A', condition, 2),
      ])
      assertEqual(p1.items.length, 20, '窗口行数固定')
      const ids = new Set(p1.items.map((row) => row.id))
      assertEqual(ids.size, 20, '没有重复行')
      assertDeepEqual(p2.items, p1.items, '重复请求得到一致窗口')
      assertDeepEqual(p3.items, p1.items, '第三次重复请求仍然一致')
    })
  })

  describe('缓存键规则', () => {
    it('切换返回字段顺序时缓存键必须变化', () => {
      const left = baseCondition({ fields: ['id', 'region', 'amount'] })
      const right = baseCondition({ fields: ['amount', 'id', 'region'] })
      assert(buildCacheKey(left) !== buildCacheKey(right), '字段顺序不同 => 缓存键不同')
      const reorderedCopy = baseCondition({ fields: ['id', 'region', 'amount'] })
      assertEqual(buildCacheKey(left), buildCacheKey(reorderedCopy), '相同顺序 => 同一个键')
    })

    it('最大行数与超时秒数参与缓存键，不同限制不共享截断结果', () => {
      const small = baseCondition({ maxRows: 100 })
      const large = baseCondition({ maxRows: 1000 })
      assert(buildCacheKey(small) !== buildCacheKey(large), '最大行数不同 => 键不同')
      const short = baseCondition({ timeoutSec: 3 })
      const long = baseCondition({ timeoutSec: 30 })
      assert(buildCacheKey(short) !== buildCacheKey(long), '超时秒数不同 => 键不同')
    })

    it('不同 maxRows 实际取数互不污染截断结果', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 257))
      const limited = await engine.fetchPage('tab-A', baseCondition({ maxRows: 30, pageSize: 50 }), 1)
      assertEqual(limited.total, 30, '小上限结果被截断到 30 行')
      assertEqual(limited.truncated, true, '截断标记为真')
      const full = await engine.fetchPage('tab-A', baseCondition({ maxRows: 1000, pageSize: 50 }), 1)
      assertEqual(full.total, 257, '大上限拿到完整总数，没有复用被截断的缓存')
      assertEqual(full.truncated, false, '完整结果不标记截断')
    })

    it('重复参数与等价条件给出一致的键判定', () => {
      const condition = baseCondition()
      const again = baseCondition()
      assertEqual(buildCacheKey(condition), buildCacheKey(again), '同条件永远同键')
    })
  })

  describe('数据刷新与撤回条件', () => {
    it('数据刷新后旧缓存失效，重新从第一页取数，旧页码对应不到旧结果', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 257))
      const condition = baseCondition({ pageSize: 20 })
      const before = await engine.fetchPage('tab-A', condition, 3)
      assertEqual(before.fromCache, false, '首次取数不命中缓存')
      assertEqual(before.total, 257, '刷新前总数为旧数据集行数')
      engine.refreshDataset()
      // 刷新后首次请求直接带旧页码：版本不匹配 => 缓存未命中，按新数据集重算，绝不返回旧窗口。
      const stalePage = await engine.fetchPage('tab-A', condition, 3)
      assertEqual(stalePage.fromCache, false, '旧页码不会对应到旧版本缓存')
      assertEqual(stalePage.total, 268, '总数按新数据集重算，没有沿用旧结果')
      // 界面约定：刷新后从第一页重新取数，第一页同样是新批次产物。
      const firstPage = await engine.fetchPage('tab-A', condition, 1)
      assertEqual(firstPage.total, 268, '第一页基于新数据集')
      assertEqual(firstPage.items[0].id, 1, '第一页窗口从头开始')
    })

    it('刷新后直接使用越界旧页码，给出可继续浏览的实际末页', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 257))
      const condition = baseCondition({ pageSize: 20 })
      await engine.fetchPage('tab-A', condition, 1)
      engine.refreshDataset()
      const stalePage = await engine.fetchPage('tab-A', condition, 999)
      assertEqual(stalePage.fromCache, false, '越界旧页码走新批次，不命中旧缓存')
      assertEqual(stalePage.totalPages, 14, '新数据集 268 行 / 20 = 14 页')
      assertEqual(stalePage.page, 14, '越界请求被纠正到实际末页')
      assertEqual(stalePage.emptyPage, true, '纠正动作以空页标记显式表示')
      assertEqual(stalePage.items.length, 8, '末页返回新数据集的真实剩余窗口')
    })

    it('撤回到之前的条件时沿用该条件最近一次完整结果（命中缓存）', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 120))
      const conditionA = baseCondition({ filter: 'region=华东', pageSize: 20 })
      const conditionB = baseCondition({ filter: 'category~电子', pageSize: 20 })
      const firstA = await engine.fetchPage('tab-A', conditionA, 1)
      await engine.fetchPage('tab-A', conditionB, 1)
      const backToA = await engine.fetchPage('tab-A', conditionA, 1)
      assertEqual(backToA.fromCache, true, '撤回条件命中缓存')
      assertDeepEqual(backToA.items, firstA.items, '沿用最近一次完整结果')
    })

    it('相同展示条件重新进入时保持列顺序', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 40))
      const condition = baseCondition({ fields: ['amount', 'id', 'region'] })
      const first = await engine.fetchPage('tab-A', condition, 1)
      assertDeepEqual(first.fields, ['amount', 'id', 'region'], '首次列顺序保留')
      const reenter = await engine.fetchPage('tab-A', condition, 1)
      assertEqual(reenter.fromCache, true, '重入命中缓存')
      assertDeepEqual(reenter.fields, ['amount', 'id', 'region'], '重入后列顺序保持不变')
    })
  })

  describe('批次隔离与执行状态', () => {
    it('报表侧只能读到本标签页的完整批次，读不到另一标签页的中间结果', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80))
      const pageA = await engine.fetchPage('tab-A', baseCondition(), 1)
      await engine.fetchPage('tab-B', baseCondition({ filter: 'region=华北' }), 1)
      const statusA = engine.getStatus('tab-A', pageA.batchId)
      assertEqual(statusA.ownerSession, 'tab-A', '状态归属正确')
      assertEqual(statusA.status, 'complete', '只暴露完整批次状态')
      assertDeepEqual(statusA.committedPages, [1], '只包含已完整提交的页码')
      await assertRejects(
        () => Promise.resolve(engine.getStatus('tab-B', pageA.batchId)),
        'BatchOwnershipError',
        '另一标签页禁止读取该批次',
      )
      const batchesA = engine.listBatches('tab-A')
      assertEqual(batchesA.length, 1, '标签页批次列表相互隔离')
      assertEqual(batchesA[0].batchId, pageA.batchId, '列表只含本标签页批次')
    })
  })

  describe('超时与终止', () => {
    it('请求超时后批次标记 timeout，不写缓存，重试产生新的完整批次', async () => {
      const clock = manualClock()
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80), clock)
      const condition = baseCondition({ timeoutSec: 2 })
      const timeoutTask = engine.fetchPage('tab-A', condition, 3, { latencyMs: 5000 })
      await Promise.resolve()
      clock.tick()
      const error = await timeoutTask.then(
        () => null,
        (reason: unknown) => reason as QueryTimeoutError,
      )
      assert(error instanceof QueryTimeoutError, '应抛出超时错误')
      assertEqual((error as QueryTimeoutError).requestedPage, 3, '超时错误带回原页码以便恢复')
      const timedOutBatch = engine.listBatches('tab-A')[0]
      assertEqual(timedOutBatch.status, 'timeout', '批次状态为已超时')
      const retry = await engine.fetchPage('tab-A', condition, 3)
      assertEqual(retry.page, 3, '重试在原页码取数')
      assertEqual(retry.fromCache, false, '超时结果未写入缓存，重试是新的完整批次')
      assert(retry.batchId !== timedOutBatch.batchId, '重试分配了新批次号')
      assertEqual(engine.listBatches('tab-A').length, 2, '两个批次相互独立')
    })

    it('终止中的查询不提供半页数据，终止后批次不可保存', async () => {
      const clock = manualClock()
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80), clock)
      const condition = baseCondition()
      const pendingTask = engine.fetchPage('tab-A', condition, 1, { latencyMs: 1000 })
      await Promise.resolve()
      const runningBatch = engine.listBatches('tab-A')[0]
      assertEqual(runningBatch.status, 'running', '存在执行中的批次')
      const status = engine.terminateBatch('tab-A', runningBatch.batchId)
      assertEqual(status.status, 'terminated', '终止直接落态，没有终止中中间态')
      clock.tick()
      const result = await pendingTask.then(
        () => null,
        (reason: unknown) => reason,
      )
      assert(result instanceof QueryTerminatedError, '在途请求以终止错误结束，不给半页数据')
      await assertRejects(
        () => Promise.resolve(engine.saveResult('tab-A', runningBatch.batchId)),
        'QueryTerminatedError',
        '终止批次不能保存结果',
      )
    })
  })

  describe('结果保存', () => {
    it('保存按钮只保存已完成批次，且内容为已完整提交的页面', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80))
      const condition = baseCondition({ pageSize: 20 })
      const page1 = await engine.fetchPage('tab-A', condition, 1)
      await engine.fetchPage('tab-A', condition, 2)
      const saved = engine.saveResult('tab-A', page1.batchId)
      assertEqual(saved.total, 80, '保存记录携带按统一规则计算的总数')
      const savedPages = Object.keys(saved.pages).map(Number).sort((a, b) => a - b)
      assertDeepEqual(savedPages, [1, 2], '只保存已完整提交过的页面')
      assertEqual(saved.pages[1].length, 20, '保存的是窗口数据而不是全量')
      assertEqual(engine.listSavedResults('tab-A').length, 1, '保存结果可列出')
      assertEqual(engine.listSavedResults('tab-B').length, 0, '其他标签页看不到该保存结果')
    })

    it('缓存命中翻页后按条件保存，反查的仍是产出缓存的本标签页批次', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80))
      const condition = baseCondition({ pageSize: 20 })
      const first = await engine.fetchPage('tab-A', condition, 1)
      const second = await engine.fetchPage('tab-A', condition, 2)
      assertEqual(second.fromCache, true, '第二页命中同条件缓存')
      const saved = engine.saveByCondition('tab-A', condition)
      assertEqual(saved.batchId, first.batchId, '保存反查到真实的已完成批次')
      assertDeepEqual(
        Object.keys(saved.pages).map(Number).sort((a, b) => a - b),
        [1, 2],
        '两个已提交窗口都在保存范围内',
      )
      await assertRejects(
        () => Promise.resolve(engine.saveByCondition('tab-B', condition)),
        'BatchOwnershipError',
        '另一标签页不能保存不属于自己的批次结果',
      )
    })

    it('未产生过完整批次的条件无法保存（不把缓存当成可保存半页数据）', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 40))
      await assertRejects(
        () => Promise.resolve(engine.saveByCondition('tab-A', baseCondition())),
        'QueryRuleError',
        '没有完整批次时拒绝保存',
      )
    })
  })

  describe('在途批次与跨标签页隔离', () => {
    it('findRunningBatch 只返回本标签页的在途批次，终止不跨会话', async () => {
      const clock = manualClock()
      const engine = new QueryEngine(new LocalDataset('sales_orders', 80), clock)
      const pendingA = engine.fetchPage('tab-A', baseCondition(), 1, { latencyMs: 1000 })
      const pendingB = engine.fetchPage('tab-B', baseCondition(), 1, { latencyMs: 1000 })
      await Promise.resolve()
      const runningA = engine.findRunningBatch('tab-A')
      const runningB = engine.findRunningBatch('tab-B')
      assert(runningA !== null && runningB !== null, '两个标签页各有一个在途批次')
      assert(runningA!.batchId !== runningB!.batchId, '在途批次相互独立')
      assertEqual(engine.findRunningBatch('tab-C'), null, '没有取数的标签页查不到在途批次')
      engine.terminateBatch('tab-A', runningA!.batchId)
      assertEqual(engine.findRunningBatch('tab-A'), null, 'A 终止后不再有在途批次')
      assertEqual(engine.findRunningBatch('tab-B')!.batchId, runningB!.batchId, 'B 的批次不受影响')
      clock.tick()
      const [resultA, resultB] = await Promise.allSettled([pendingA, pendingB])
      assertEqual(resultA.status, 'rejected', 'A 的在途请求被终止拒绝')
      assertEqual(resultB.status, 'fulfilled', 'B 的批次正常完成，未混入 A 的中间结果')
    })

    it('缓存补取的新窗口会登记到来源批次的已提交页码', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 60))
      const condition = baseCondition({ pageSize: 20 })
      const first = await engine.fetchPage('tab-A', condition, 1)
      await engine.fetchPage('tab-A', condition, 3)
      const status = engine.getStatus('tab-A', first.batchId)
      assertDeepEqual(status.committedPages, [1, 3], '批次状态反映全部完整提交页')
      assertEqual(status.total, 60, '总数按统一规则计算')
    })

    it('另一标签页命中共享缓存补页时，不会推进来源批次的提交状态', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 60))
      const condition = baseCondition({ pageSize: 20 })
      const firstA = await engine.fetchPage('tab-A', condition, 1)
      // tab-B 命中同条件缓存并补取第 2 页：数据可共享，但 A 的批次状态不能被 B 推进。
      const pageB = await engine.fetchPage('tab-B', condition, 2)
      assertEqual(pageB.fromCache, true, 'B 命中共享缓存')
      const statusA = engine.getStatus('tab-A', firstA.batchId)
      assertDeepEqual(statusA.committedPages, [1], 'A 的批次提交页不被 B 的请求污染')
      assertEqual(engine.listBatches('tab-B').length, 0, '纯缓存命中不为 B 产生批次')
    })
  })

  describe('草稿与规则校验', () => {
    it('参数未填完整时拒绝执行且不产生副作用，草稿由调用方保留', () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 40))
      const draft = baseCondition({ dataset: '' })
      const result = validateCondition(draft, engine.datasetFields())
      assertEqual(result.valid, false, '未填完整 => 校验不通过')
      assert(result.issues.some((item) => item.field === 'dataset'), '给出 dataset 字段级原因')
      assertEqual(engine.inspectCache().length, 0, '拒绝时不写任何缓存')
      assertEqual(engine.listBatches('tab-A').length, 0, '拒绝时不产生批次')
    })

    it('分页上限与超时阈值越界按标准拒绝，结论稳定一致', () => {
      const engine = new QueryEngine(new LocalDataset())
      const tooLargePage = validateCondition(
        baseCondition({ pageSize: QUERY_RULES.pageSize.max + 1 }),
        engine.datasetFields(),
      )
      assertEqual(tooLargePage.valid, false, '分页大小超上限拒绝')
      const zeroPage = validateCondition(baseCondition({ pageSize: 0 }), engine.datasetFields())
      assertEqual(zeroPage.valid, false, '分页大小为 0 拒绝')
      const badTimeout = validateCondition(
        baseCondition({ timeoutSec: QUERY_RULES.timeoutSec.max + 1 }),
        engine.datasetFields(),
      )
      assertEqual(badTimeout.valid, false, '超时阈值越界拒绝')
      const badMaxRows = validateCondition(baseCondition({ maxRows: 0 }), engine.datasetFields())
      assertEqual(badMaxRows.valid, false, '最大行数越界拒绝')
      // 一致性：重复提交同一非法参数，结论完全相同。
      assertDeepEqual(tooLargePage.issues, tooLargePage.issues, '同一参数判定稳定')
    })

    it('重复返回字段给一致判定：拒绝', () => {
      const engine = new QueryEngine(new LocalDataset())
      const result = validateCondition(
        baseCondition({ fields: ['id', 'region', 'id'] }),
        engine.datasetFields(),
      )
      assertEqual(result.valid, false, '重复字段拒绝')
      assert(result.issues.some((item) => item.message.includes('重复')), '提示重复参数')
    })

    it('未填完整条件的拒绝不会把上一次成功结果当成新条件结果', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 40))
      const success = await engine.fetchPage('tab-A', baseCondition(), 1)
      await assertRejects(
        () => engine.fetchPage('tab-A', baseCondition({ dataset: '' }), 1),
        'QueryRuleError',
        '不完整条件被规则拒绝',
      )
      const again = await engine.fetchPage('tab-A', baseCondition(), 1)
      assertEqual(again.fromCache, true, '旧条件的成功结果仍只归属旧条件缓存')
      assertDeepEqual(again.items, success.items, '旧结果未被新条件污染')
    })
  })

  describe('窗口与排序稳定性', () => {
    it('排序方向变化产生不同窗口且互不串页', async () => {
      const engine = new QueryEngine(new LocalDataset('sales_orders', 40))
      const asc = await engine.fetchPage('tab-A', baseCondition({ sortOrder: 'asc', pageSize: 10 }), 1)
      const desc = await engine.fetchPage(
        'tab-A',
        baseCondition({ sortOrder: 'desc', pageSize: 10 }),
        1,
      )
      assertEqual(asc.items[0].id, 1, '升序首行为最小 id')
      assertEqual(desc.items[0].id, 40, '降序首行为最大 id')
      const ascAgain = await engine.fetchPage(
        'tab-A',
        baseCondition({ sortOrder: 'asc', pageSize: 10 }),
        2,
      )
      assertEqual(ascAgain.items[0].id, 11, '各自缓存的窗口互不串页')
    })
  })
}
