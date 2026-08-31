# 调度重构生产性能报告工作说明

## 报告契约

- 受众：技术读者
- 交付面：MCP app report
- 数据窗口：2026-08-28 02:37:04–09:02:04，Asia/Shanghai
- 主要输入：两份 task-metrics JSONL、已执行 notebook、调度与任务指标实现

## 结构映射

- Technical summary：直接回答当前表现与正式验收边界
- Key findings：HTTP 长尾、好友切片、后台/交互对照
- Scope and definitions：时间、账号、P95 与 waitMs 语义
- Methodology：直方图合并、数据质量与独立复算
- Limitations：无旧版基线、无好友总数、五分钟聚合无法还原单次因果
- Next steps and questions：任务关联、超时取消、300 好友受控测试

## Chart map

| 报告段落 | 问题 | 图形 | 字段 | 支持结论 |
| --- | --- | --- | --- | --- |
| HTTP 长尾 | 哪些路由形成响应长尾 | 排序横向条形图 | route, p95_upper_ms, n, p99, max | GET /api/seeds 是稀疏长尾，高频 GET /api/bag 常态较快 |
| 好友切片 | 哪些任务仍可能长时间占用执行槽 | 排序横向条形图 | task, run_p95_upper_ms, n, mean, max | 单好友捣乱事务是好友链路主要尾部 |

两张图都属于类别比较且单位一致，因此都使用横向条形图；一个比较 HTTP 路由，另一个比较业务任务。好友活跃/非活跃只有两个状态且精确值更重要，使用表格。没有绘制时间趋势，因为五分钟聚合的核心问题是尾部分布与阻塞类别，不是连续趋势形状。

## QA

- notebook：11 个单元格、6 个代码单元格，全部执行，无 error output
- 独立复算：账号任务数、HTTP 数、真实队列 P95、GET P95、好友轮运行 P95、最大交互等待、最大队列深度全部一致
- artifact validator：ready，7 个数据集，完整来源与有序 blocks
- 账号 ID：报告快照只保留 A01–A03 别名
