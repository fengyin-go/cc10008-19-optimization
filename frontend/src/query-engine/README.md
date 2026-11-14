# 查询引擎需求落点说明

本模块在纯前端骨架内新增框架无关的查询引擎（`src/query-engine/`）与双标签页演示工作台
（`src/views/query-workbench/`），自动化测试位于 `tests/`，运行 `npm test` 即可。

## 需求 → 代码 → 测试对照

| # | 业务约束 | 实现位置 | 覆盖测试 |
|---|----------|----------|----------|
| 1 | 响应只取当前页窗口，总数按同一规则计算 | `dataset.prepareQuery` 统一产出全量结果，`pageWindow` 只切窗口；`engine.buildPageResult` 同时回传窗口与 total | 分页窗口与总数规则 / 响应只取当前页窗口… |
| 2 | 数据刷新后从第一页重新取数；旧页码给出可继续浏览的末页 | `LocalDataset.refresh` 版本号 +1；缓存按 `datasetVersion` 失效；`clampPage` 把越界页码纠正到实际末页 | 数据刷新与撤回条件 / 刷新后…两个用例 |
| 3 | 报表侧只拿完整批次，不混入另一标签页中间结果 | 批次带 `ownerSession`；`getStatus/listBatches/terminateBatch/saveResult` 全部走 `requireOwnedBatch`，状态只暴露 `committedPages` | 批次隔离、在途批次与跨标签页隔离两个用例组 |
| 4 | 切换返回字段顺序缓存键必须变化 | `buildCacheKey` 将字段数组按顺序序列化进键 | 缓存键规则 / 切换返回字段顺序… |
| 5 | 零行与空页区分表示 | `QueryPage.zeroRows`（total=0）与 `emptyPage`（请求页越界被纠正）两个独立标记 | 分页窗口与总数规则 / 零行结果与空页…、最后一页超过总行数… |
| 6 | 撤回到之前条件沿用最近一次完整结果 | 同条件同键命中缓存，`fromCache=true`，窗口内容深拷贝一致 | 数据刷新与撤回条件 / 撤回到之前的条件… |
| 7 | 最大行数、超时秒数参与缓存键，不同限制不共享截断结果 | 两者均写入 `buildCacheKey`；截断在 `prepareQuery` 按各条件独立计算并标 `truncated` | 缓存键规则 / 最大行数与超时秒数…、不同 maxRows… |
| 8 | 超时后恢复原页码，允许重试新的完整批次 | `QueryTimeoutError.requestedPage` 带回原页码；超时批次不写缓存，重试另建批次 | 超时与终止 / 请求超时后… |
| 9 | 保存按钮只保存已完成批次，终止中不给半页数据 | `saveResult` 强制 `status==='complete'`；终止直接落 `terminated`，无「终止中」中间态，在途 Promise 以 `QueryTerminatedError` 结束 | 超时与终止 / 终止中的查询…、结果保存三个用例 |
| 10 | 相同展示条件重入保持列顺序 | 缓存条目保存 `fields` 顺序，命中结果原样回传 | 数据刷新与撤回条件 / 相同展示条件重新进入… |
| 11 | 翻页请求重复到达不追加重复行 | `inFlight` 以 `session::cacheKey::page` 去重，并发同页共用同一 Promise | 分页窗口与总数规则 / 翻页请求重复到达… |
| 12 | 最后一页超过总行数回到实际末页 | `clampPage` + `emptyPage` 标记，界面页码同步纠正 | 分页窗口与总数规则 / 最后一页超过总行数… |
| 13 | 参数未填完整保留草稿，不把上次成功结果当新条件结果 | 校验失败时引擎零副作用（不建批次、不写缓存）；界面保留表单并提示，已有结果归属旧条件 | 草稿与规则校验 / 参数未填完整…、未填完整条件的拒绝… |
| 14 | 分页上限与超时阈值纳入规则，越界标准拒绝，重复参数一致判定 | `QUERY_RULES` 集中定义；`validateCondition` 纯函数判定；重复返回字段拒绝 | 草稿与规则校验 / 分页上限…、重复返回字段… |

## 关键设计说明

1. **缓存键与数据版本解耦**：键由条件（含字段顺序、maxRows、timeoutSec）决定；数据集版本不进键，
   而在命中时比对 `datasetVersion` 失效。这样刷新后同条件必然重新取数，不会把旧页码对应到旧数据。
2. **批次与缓存的关系**：缓存未命中才创建批次；同键后续翻页命中缓存，新窗口补写回同一缓存条目，
   并登记到来源批次的 `committedPages`，报表读到的始终是该批次的完整进展。
3. **零行 vs 空页**：零行是过滤/截断后 total=0（第一页也无数据）；空页是 total>0 但请求页超出末页，
   引擎纠正到实际末页并保留 `requestedPage` 供界面提示。
4. **超时模拟**：引擎通过可注入的 `EngineClock` 控制时延，`latencyMs > timeoutSec*1000` 即超时；
   工作台可直接输入模拟耗时观察超时、恢复页码与重试行为。
5. **持久化**：仅「已保存结果」写入 localStorage（`storage.ts`），缓存与批次保留在内存，
   符合刷新数据集后缓存整体失效的语义。

## 测试方式

```bash
npm run typecheck   # 严格 TS 类型检查
npm test            # Vite SSR 加载器运行 26 项规则测试，无第三方测试依赖
npm run build       # 生产构建
```
