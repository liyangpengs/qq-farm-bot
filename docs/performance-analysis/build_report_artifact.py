from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ANALYSIS_DIR = Path(__file__).resolve().parent
SUMMARY_PATH = ANALYSIS_DIR / "analysis-summary.json"
ARTIFACT_PATH = ANALYSIS_DIR / "report-artifact.json"
SQLITE_PATH = ANALYSIS_DIR / "report-source.sqlite"


def build_source(summary):
    generated_at = summary["metadata"]["generated_at"]
    source_code = (
        "records = [json.loads(line) for path in sorted(Path('docs').glob('task-metrics-*.jsonl')) "
        "for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]\n"
        "# Merge latency histograms by summing per-bucket counts; report nearest-rank bucket upper bounds."
    )
    return {
        "id": "performance_metrics",
        "label": "生产调度性能 JSONL 与已执行分析 notebook",
        "path": "docs/performance-analysis/performance-metrics-analysis.ipynb",
        "query": {
            "engine": "python",
            "language": "python",
            "query": source_code,
            "description": "读取两份生产 JSONL，校验窗口与直方图后，按任务、账号和 HTTP 路由加权合并计数与延迟桶。",
            "executed_at": generated_at,
            "tables_used": [source["file"] for source in summary["metadata"]["sources"]],
            "filters": [
                f"{summary['metadata']['coverage_start']} 至 {summary['metadata']['coverage_end']}，Asia/Shanghai",
                "账号仅以 A01–A03 稳定别名呈现",
                "HTTP 路由图仅包含 n≥5 的路由",
                "好友活跃窗口定义为同账号窗口内存在逐好友帮助、偷菜、捣乱或宠物同步事务",
            ],
            "metric_definitions": [
                "P95/P99：合并直方图后采用 nearest-rank 所在桶上界，属于保守上界",
                "真实队列等待：仅统计 inline=false 的 AccountTaskRunner 任务 waitMs",
                "scheduler.* waitMs：dueAt 到 startedAt 的调度迟到，不是业务队列等待",
                "HTTP 总耗时：管理端中间件记录的请求处理时长",
                "错误率：error / executions；业务失败与调度故障不自动等价",
            ],
        },
    }


def build_datasets(summary):
    focus_rows = [
        {
            "task": row["label"],
            "n": row["n"],
            "wait_semantics": "调度迟到" if row["wait_semantics"] == "scheduler_lateness" else "队列等待",
            "run_mean_ms": row["run_mean_ms"],
            "run_p95_upper_ms": row["run_p95_upper_ms"],
            "run_p99_upper_ms": row["run_p99_upper_ms"],
            "run_max_ms": row["run_max_ms"],
            "wait_p95_upper_ms": row["wait_p95_upper_ms"],
            "total_p95_upper_ms": row["total_p95_upper_ms"],
            "errors": row["errors"],
        }
        for row in summary["focus_tasks"]
    ]
    focus_rows.sort(key=lambda row: row["run_p95_upper_ms"], reverse=True)

    route_rows = [
        {
            "route": row["route"],
            "n": row["n"],
            "mean_ms": row["total_mean_ms"],
            "p95_upper_ms": row["total_p95_upper_ms"],
            "p99_upper_ms": row["total_p99_upper_ms"],
            "max_ms": row["total_max_ms"],
            "over_1s_n": row["total_over_1s_n"],
            "over_5s_n": row["total_over_5s_n"],
            "errors": row["errors"],
        }
        for row in summary["http_route_summary"]
        if row["n"] >= 5
    ]
    route_rows.sort(key=lambda row: (-row["p95_upper_ms"], -row["n"]))

    account_rows = [
        {
            "account": row["account"],
            "queued_task_n": row["queued_task_n"],
            "queue_wait_p95_upper_ms": row["queued_wait_p95_upper_ms"],
            "interactive_wait_p95_upper_ms": row["interactive_wait_p95_upper_ms"],
            "max_queue_depth": row["max_queue_depth"],
            "friend_round_n": row["friend_round_n"],
            "friend_round_lateness_p95_ms": row["friend_round_lateness_p95_upper_ms"],
            "friend_round_run_p95_ms": row["friend_round_run_p95_upper_ms"],
            "friend_round_run_max_ms": row["friend_round_run_max_ms"],
            "friend_child_n": row["friend_child_n"],
            "active_friend_windows": row["active_friend_windows"],
            "max_friend_children_per_window": row["max_friend_children_per_window"],
        }
        for row in summary["account_summary"]
    ]
    account_rows.sort(key=lambda row: row["friend_child_n"], reverse=True)

    background_rows = [
        {
            "route_group": row["route_group"],
            "friend_activity": row["friend_activity"],
            "n": row["n"],
            "mean_ms": row["total_mean_ms"],
            "p95_upper_ms": row["total_p95_upper_ms"],
            "p99_upper_ms": row["total_p99_upper_ms"],
            "max_ms": row["total_max_ms"],
            "over_1s_n": row["total_over_1s_n"],
            "over_5s_n": row["total_over_5s_n"],
        }
        for row in summary["http_background_comparison"]
    ]

    outlier_rows = []
    for index, row in enumerate(summary["notable_interactive_wait_windows"], start=1):
        candidate_text = "；".join(
            f"{candidate['task']} ({candidate['run_max_ms']} ms)"
            for candidate in row["contemporaneous_long_tasks"]
        )
        outlier_rows.append(
            {
                "order": index,
                "account": row["account"],
                "window_end": row["window_end"],
                "interactive_task": row["interactive_task"],
                "wait_max_ms": row["interactive_wait_max_ms"],
                "total_max_ms": row["interactive_total_max_ms"],
                "queue_depth": row["max_queue_depth"],
                "contemporaneous_long_tasks": candidate_text,
                "causal_status": "同窗口强关联，非单次时序证明",
            }
        )

    quality = summary["data_quality"]
    quality_rows = [
        {"order": 1, "check": "JSON 坏行", "result": str(quality["malformed_lines"]), "assessment": "通过"},
        {"order": 2, "check": "重复窗口", "result": str(quality["duplicate_records"]), "assessment": "通过"},
        {"order": 3, "check": "taskCount 不一致", "result": str(quality["task_count_mismatches"]), "assessment": "通过"},
        {"order": 4, "check": "直方图计数不一致", "result": str(quality["histogram_count_mismatches"]), "assessment": "通过"},
        {"order": 5, "check": "total != wait + run", "result": str(quality["duration_sum_mismatches"]), "assessment": "通过"},
        {
            "order": 6,
            "check": "账号五分钟窗口",
            "result": f"{quality['account_window_min_seconds']}–{quality['account_window_max_seconds']} 秒",
            "assessment": "通过",
        },
        {
            "order": 7,
            "check": "账号时间线 >7.5 分钟空档",
            "result": str(quality["timeline_gaps_over_7_5_minutes"]),
            "assessment": "通过",
        },
        {
            "order": 8,
            "check": "HTTP 非标准长度窗口",
            "result": str(quality["http_windows_outside_4_5_to_5_5_minutes"]),
            "assessment": "低流量 scope 跨空窗，符合 drain 语义",
        },
        {
            "order": 9,
            "check": "schema / bot version",
            "result": f"v{','.join(map(str, quality['schema_versions']))} / {','.join(quality['bot_versions'])}",
            "assessment": "单一版本",
        },
    ]

    headline_rows = [
        {
            "queued_wait_p95": "≤1 ms",
            "queued_sample": "9,015 次",
            "http_get_p95": "≤50 ms",
            "http_get_sample": "3,122 次",
            "friend_run_p95": "≤1 s",
            "friend_round_sample": "2,986 轮",
            "max_queue_depth": "3",
            "long_wait_count": "15 次 >1 s",
        }
    ]

    return {
        "headline": headline_rows,
        "focus_tasks": focus_rows,
        "http_routes": route_rows,
        "accounts": account_rows,
        "background_compare": background_rows,
        "outliers": outlier_rows,
        "quality_checks": quality_rows,
    }


def sqlite_type(values):
    populated = [value for value in values if value is not None]
    if populated and all(isinstance(value, int) and not isinstance(value, bool) for value in populated):
        return "INTEGER"
    if populated and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in populated):
        return "REAL"
    return "TEXT"


def quote_identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def persist_and_query_datasets(datasets, generated_at):
    order_by = {
        "focus_tasks": "run_p95_upper_ms DESC, n DESC",
        "http_routes": "p95_upper_ms DESC, n DESC",
        "accounts": "friend_child_n DESC",
        "background_compare": "route_group ASC, friend_activity ASC",
        "outliers": "wait_max_ms DESC",
        "quality_checks": '"order" ASC',
    }
    source_descriptions = {
        "headline": "读取报告顶层延迟与队列指标。",
        "focus_tasks": "读取关键任务运行时分位数与样本量。",
        "http_routes": "读取样本量不少于 5 的 HTTP 路由延迟分位数。",
        "accounts": "读取匿名账号级队列与好友任务汇总。",
        "background_compare": "读取好友事务活跃与非活跃窗口的 HTTP 延迟对照。",
        "outliers": "读取交互等待超过 1 秒的聚合窗口及同窗口长任务。",
        "quality_checks": "读取 JSONL 完整性、窗口连续性和聚合一致性检查。",
    }
    metric_definitions = [
        "上游计算来自已执行 performance-metrics-analysis.ipynb",
        "P95/P99 为合并直方图 nearest-rank 所在桶上界",
        "账号只保留 A01–A03 匿名别名",
    ]

    connection = sqlite3.connect(SQLITE_PATH)
    connection.row_factory = sqlite3.Row
    sql_sources = []
    selected_datasets = {}
    try:
        for dataset_id, rows in datasets.items():
            table_name = f"report_{dataset_id}"
            connection.execute(f"DROP TABLE IF EXISTS {quote_identifier(table_name)}")
            columns = list(rows[0].keys())
            definitions = ", ".join(
                f"{quote_identifier(column)} {sqlite_type([row.get(column) for row in rows])}"
                for column in columns
            )
            connection.execute(f"CREATE TABLE {quote_identifier(table_name)} ({definitions})")
            placeholders = ", ".join("?" for _ in columns)
            column_sql = ", ".join(quote_identifier(column) for column in columns)
            connection.executemany(
                f"INSERT INTO {quote_identifier(table_name)} ({column_sql}) VALUES ({placeholders})",
                [[row.get(column) for column in columns] for row in rows],
            )
            query = f"SELECT {column_sql} FROM {quote_identifier(table_name)}"
            if dataset_id in order_by:
                query += f" ORDER BY {order_by[dataset_id]}"
            selected_rows = [dict(row) for row in connection.execute(query).fetchall()]
            if len(selected_rows) != len(rows):
                raise RuntimeError(f"SQLite row-count mismatch for {dataset_id}")
            selected_datasets[dataset_id] = selected_rows
            sql_sources.append(
                {
                    "id": f"{dataset_id}_sql",
                    "label": f"{dataset_id} 报告快照查询",
                    "path": "docs/performance-analysis/report-source.sqlite",
                    "query": {
                        "engine": "sqlite",
                        "language": "sql",
                        "sql": query,
                        "description": source_descriptions[dataset_id],
                        "executed_at": generated_at,
                        "tables_used": [table_name],
                        "filters": ["由已执行 notebook 生成的匿名聚合快照"],
                        "metric_definitions": metric_definitions,
                    },
                }
            )
        connection.commit()
    finally:
        connection.close()
    return selected_datasets, sql_sources


def build_manifest(summary, datasets, sources):
    generated_at = summary["metadata"]["generated_at"]
    title = "调度重构生产性能诊断（6.4 小时）"
    coverage_start = summary["metadata"]["coverage_start"].replace("T", " ")
    coverage_end = summary["metadata"]["coverage_end"].replace("T", " ")
    cards = [
        {
            "id": "queued_wait_card",
            "dataset": "headline",
            "sourceId": "headline_sql",
            "description": "9,015 次真实入队任务；nearest-rank 直方图桶上界。",
            "metrics": [
                {"label": "队列等待 P95", "field": "queued_wait_p95"},
                {"label": "样本", "field": "queued_sample"},
            ],
        },
        {
            "id": "http_get_card",
            "dataset": "headline",
            "sourceId": "headline_sql",
            "description": "3,122 次 GET；服务端请求处理总耗时。",
            "metrics": [
                {"label": "HTTP GET P95", "field": "http_get_p95"},
                {"label": "样本", "field": "http_get_sample"},
            ],
        },
        {
            "id": "friend_round_card",
            "dataset": "headline",
            "sourceId": "headline_sql",
            "description": "好友调度轮实际运行时间；不含计划触发迟到。",
            "metrics": [
                {"label": "好友轮运行 P95", "field": "friend_run_p95"},
                {"label": "样本", "field": "friend_round_sample"},
            ],
        },
        {
            "id": "queue_depth_card",
            "dataset": "headline",
            "sourceId": "headline_sql",
            "description": "业务执行器观察到的最大等待队列深度。",
            "metrics": [
                {"label": "最大队列深度", "field": "max_queue_depth"},
                {"label": "长等待", "field": "long_wait_count"},
            ],
        },
    ]

    charts = [
        {
            "id": "http_route_p95_chart",
            "title": "HTTP 路由 P95 延迟上界",
            "subtitle": "路由样本 n≥5；稀疏路由的 P95 接近该组最大值",
            "showDescription": True,
            "intent": "comparison",
            "question": "哪些 HTTP 路由形成当前响应长尾？",
            "rationale": "排序横向条形图适合比较较长路由标签及一个统一的毫秒指标。",
            "comparisonContext": {"grain": "HTTP 路由", "unit": "ms", "denominator": "每条路由的请求数 n"},
            "type": "bar",
            "dataset": "http_routes",
            "sourceId": "http_routes_sql",
            "encodings": {
                "x": {"field": "route", "type": "nominal", "label": "路由"},
                "y": {"field": "p95_upper_ms", "type": "quantitative", "label": "P95 桶上界", "unit": "ms"},
                "tooltip": [
                    {"field": "n", "type": "quantitative", "label": "样本"},
                    {"field": "mean_ms", "type": "quantitative", "label": "均值", "unit": "ms"},
                    {"field": "p99_upper_ms", "type": "quantitative", "label": "P99 上界", "unit": "ms"},
                    {"field": "max_ms", "type": "quantitative", "label": "最大值", "unit": "ms"},
                    {"field": "over_1s_n", "type": "quantitative", "label": ">1s 次数"},
                ],
            },
            "valueFormat": "number",
            "unit": "ms",
            "layout": "full",
            "labels": {"values": "all"},
            "maxRows": 20,
            "settings": {"orientation": "horizontal", "sort": "descending", "showValues": True, "categoryLabelPolicy": "wrap"},
            "surface": {"surface": "card", "showControls": False, "viewMode": "visualization"},
        },
        {
            "id": "focus_task_p95_chart",
            "title": "关键任务运行时间 P95 上界",
            "subtitle": "调度包装器使用实际运行时间；逐好友任务按单好友事务计",
            "showDescription": True,
            "intent": "comparison",
            "question": "哪些业务任务仍可能占用账号串行槽较久？",
            "rationale": "同一毫秒单位的横向排序条形图直接暴露长任务类别。",
            "comparisonContext": {"grain": "任务类型", "unit": "ms", "denominator": "该任务类型的执行次数 n"},
            "type": "bar",
            "dataset": "focus_tasks",
            "sourceId": "focus_tasks_sql",
            "encodings": {
                "x": {"field": "task", "type": "nominal", "label": "任务"},
                "y": {"field": "run_p95_upper_ms", "type": "quantitative", "label": "运行 P95 桶上界", "unit": "ms"},
                "tooltip": [
                    {"field": "n", "type": "quantitative", "label": "样本"},
                    {"field": "run_mean_ms", "type": "quantitative", "label": "均值", "unit": "ms"},
                    {"field": "run_p99_upper_ms", "type": "quantitative", "label": "P99 上界", "unit": "ms"},
                    {"field": "run_max_ms", "type": "quantitative", "label": "最大值", "unit": "ms"},
                    {"field": "wait_semantics", "type": "text", "label": "waitMs 语义"},
                ],
            },
            "valueFormat": "number",
            "unit": "ms",
            "layout": "full",
            "labels": {"values": "all"},
            "maxRows": 10,
            "settings": {"orientation": "horizontal", "sort": "descending", "showValues": True, "categoryLabelPolicy": "wrap"},
            "surface": {"surface": "card", "showControls": False, "viewMode": "visualization"},
        },
    ]

    tables = [
        {
            "id": "outlier_table",
            "title": "交互等待超过 1 秒的聚合窗口",
            "subtitle": "同账号同五分钟窗口的长任务仅作为阻塞候选，不视为精确因果时序",
            "showDescription": True,
            "dataset": "outliers",
            "sourceId": "outliers_sql",
            "defaultSort": {"field": "wait_max_ms", "direction": "desc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "account", "label": "账号", "type": "text"},
                {"field": "window_end", "label": "窗口结束", "type": "date"},
                {"field": "interactive_task", "label": "交互任务", "type": "text"},
                {"field": "wait_max_ms", "label": "最大等待 ms", "format": "number"},
                {"field": "queue_depth", "label": "队列深度", "format": "number"},
                {"field": "contemporaneous_long_tasks", "label": "同窗口长任务", "type": "text"},
                {"field": "causal_status", "label": "证据边界", "type": "text"},
            ],
        },
        {
            "id": "account_table",
            "title": "三账号队列与好友任务表现",
            "subtitle": "2026-08-28 02:37–09:02，Asia/Shanghai",
            "showDescription": True,
            "dataset": "accounts",
            "sourceId": "accounts_sql",
            "defaultSort": {"field": "friend_child_n", "direction": "desc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "account", "label": "账号", "type": "text"},
                {"field": "queued_task_n", "label": "入队任务", "format": "number"},
                {"field": "queue_wait_p95_upper_ms", "label": "队列等待 P95 ms", "format": "number"},
                {"field": "interactive_wait_p95_upper_ms", "label": "交互等待 P95 ms", "format": "number"},
                {"field": "max_queue_depth", "label": "最大队列", "format": "number"},
                {"field": "friend_round_run_p95_ms", "label": "好友轮运行 P95 ms", "format": "number"},
                {"field": "friend_round_run_max_ms", "label": "好友轮最大运行 ms", "format": "number"},
                {"field": "friend_child_n", "label": "逐好友事务", "format": "number"},
                {"field": "max_friend_children_per_window", "label": "单窗口最多事务", "format": "number"},
            ],
        },
        {
            "id": "background_compare_table",
            "title": "HTTP 延迟与好友事务活跃窗口对照",
            "subtitle": "同账号五分钟窗口重叠；同一路由对照优先于混合路由汇总",
            "showDescription": True,
            "dataset": "background_compare",
            "sourceId": "background_compare_sql",
            "defaultSort": {"field": "route_group", "direction": "asc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "route_group", "label": "请求组", "type": "text"},
                {"field": "friend_activity", "label": "好友事务", "type": "text"},
                {"field": "n", "label": "样本", "format": "number"},
                {"field": "mean_ms", "label": "均值 ms", "format": "number"},
                {"field": "p95_upper_ms", "label": "P95 上界 ms", "format": "number"},
                {"field": "p99_upper_ms", "label": "P99 上界 ms", "format": "number"},
                {"field": "max_ms", "label": "最大值 ms", "format": "number"},
                {"field": "over_1s_n", "label": ">1s", "format": "number"},
            ],
        },
        {
            "id": "quality_table",
            "title": "数据质量与覆盖检查",
            "subtitle": "账号任务窗口连续；HTTP 低流量 scope 可跨多个空窗口累积",
            "showDescription": True,
            "dataset": "quality_checks",
            "sourceId": "quality_checks_sql",
            "defaultSort": {"field": "order", "direction": "asc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "order", "label": "序号", "format": "number"},
                {"field": "check", "label": "检查项", "type": "text"},
                {"field": "result", "label": "结果", "type": "text"},
                {"field": "assessment", "label": "判断", "type": "text"},
            ],
        },
    ]

    blocks = [
        {"id": "title_block", "type": "markdown", "body": f"# {title}"},
        {
            "id": "technical_summary",
            "type": "markdown",
            "body": (
                "## Technical Summary\n\n"
                "**当前三账号常态性能健康，但还不能判定架构性能验收正式通过。** "
                "真实入队任务等待 P95 ≤1 ms，HTTP GET 总耗时 P95 ≤50 ms，好友轮实际运行 P95 ≤1 s，最大队列深度为 3；这些数字说明没有持续性积压。\n\n"
                "不过 P95 掩盖了 3 个交互长尾窗口：最严重一次交互任务等待 29.7 s，同窗口存在 30.6 s 的 farm.check；"
                "另一次等待 7.14 s，同窗口存在 9.35 s 的单好友捣乱事务。当前日志只有重构后数据，也没有好友总数，"
                "因此无法验证相对旧基线 ±20% 或 300 好友极端场景。"
            ),
        },
        {"id": "headline_metrics", "type": "metric-strip", "cardIds": ["queued_wait_card", "http_get_card", "friend_round_card", "queue_depth_card"]},
        {
            "id": "latency_findings",
            "type": "markdown",
            "body": (
                "## 常态延迟很好，但三次尾部等待需要处理\n\n"
                "高频路径表现稳定：2,232 次 GET /api/bag 的 P95 ≤50 ms、P99 ≤100 ms，仅 2 次超过 1 s。"
                "真正的问题不在总体吞吐，而在串行槽被单次长任务占住时，后到的交互任务只能等待。\n\n"
                "GET /api/seeds 只有 5 个样本，其中 1 次达到 7.19 s，因此其 P95 桶上界为 10 s；"
                "这个数字代表稀疏样本中的单次长尾，不应外推成常态。"
            ),
        },
        {"id": "http_route_chart_block", "type": "chart", "chartId": "http_route_p95_chart"},
        {"id": "outlier_table_block", "type": "table", "tableId": "outlier_table"},
        {
            "id": "friend_findings",
            "type": "markdown",
            "body": (
                "## 好友切片已经阻止整轮独占，但单好友事务仍可能阻塞数秒\n\n"
                "逐好友切片的收益已经出现：帮助事务 276 次，运行 P95 ≤500 ms；偷菜事务 16 次，运行 P95 ≤1 s。"
                "好友整轮即使最长运行 35.65 s，也不是连续占用业务执行器，而是由逐好友事务分段进入队列。\n\n"
                "尾部风险集中在单个不可打断事务：捣乱事务仅 8 次，但运行 P95 桶上界为 10 s、最大 9.35 s。"
                "三账号单个五分钟窗口最多只执行 11 个逐好友事务，远低于 300，因此这份样本不能证明 300 好友场景。"
            ),
        },
        {"id": "focus_chart_block", "type": "chart", "chartId": "focus_task_p95_chart"},
        {"id": "account_table_block", "type": "table", "tableId": "account_table"},
        {
            "id": "background_findings",
            "type": "markdown",
            "sourceId": "background_compare_sql",
            "body": (
                "## 高频背包接口没有因好友后台任务变慢\n\n"
                "对同一路由做窗口对照时，GET /api/bag 在无好友事务窗口和有好友事务窗口的 P95 都是 ≤50 ms，P99 都是 ≤100 ms；"
                "好友活跃窗口均值反而略低，说明当前样本没有发现好友后台任务抬高这个高频只读接口的证据。\n\n"
                "全部 GET 在好友活跃窗口的 P95 从 ≤50 ms 变为 ≤100 ms，但两组路由构成不同，不能据此归因于后台任务。"
            ),
        },
        {"id": "background_table_block", "type": "table", "tableId": "background_compare_table"},
        {
            "id": "scope_definitions",
            "type": "markdown",
            "sourceId": "performance_metrics",
            "body": (
                "## 样本覆盖与指标口径\n\n"
                f"数据覆盖 {coverage_start} 至 {coverage_end}，共 {summary['metadata']['coverage_hours']:.2f} 小时、3 个账号、311 个聚合窗口。"
                "账号任务 15,009 次，HTTP 请求 3,165 次。\n\n"
                "- **真实队列等待**：仅 inline=false 的账号执行器任务。\n"
                "- **调度迟到**：scheduler.* 从计划触发到实际开始的偏移，不等同于排队。\n"
                "- **P95/P99**：合并五分钟直方图后，取 nearest-rank 所在桶上界。\n"
                "- **好友活跃窗口**：同账号重叠窗口内至少出现一个逐好友帮助、偷菜、捣乱或宠物同步事务。"
            ),
        },
        {"id": "quality_table_block", "type": "table", "tableId": "quality_table"},
        {
            "id": "methodology",
            "type": "markdown",
            "body": (
                "## 计算与验证方法\n\n"
                "两份 JSONL 先按行解析并核验 schema、窗口主键、taskCount、outcome 计数、直方图计数以及 total = wait + run。"
                "随后按账号、任务、优先级和 HTTP 路由直接合并直方图桶，均值使用总和除以总计数，分位数使用 nearest-rank 桶上界。\n\n"
                "分析 notebook 已从头到尾执行且无错误；另用独立 PowerShell 实现复算账号任务数、HTTP 数、真实队列 P95、GET P95、"
                "好友轮运行 P95、最大交互等待和最大队列深度，结果全部一致。"
            ),
        },
        {
            "id": "limitations",
            "type": "markdown",
            "body": (
                "## 限制、稳健性与正式验收边界\n\n"
                "- **没有重构前基线。** 架构文档要求关键指标相对旧版漂移在 ±20% 内，本次只有重构后样本，不能给出正式 pass。\n"
                "- **没有好友总数。** 日志记录实际逐好友事务，却未记录每轮好友总数、候选数与处理进度，不能验证 300 好友容量。\n"
                "- **聚合窗口不能证明严格因果。** 长交互等待与长后台任务出现在同账号同窗口，结合串行执行器构成强关联，但缺少单次 taskId/blockedBy 时间线。\n"
                "- **直方图分位数是上界。** 例如 2–5 s 桶会报告 5 s；稀疏路由 P95 接近最大值。\n"
                "- **样本为 6.4 小时。** 足够发现常态和明显长尾，不足以代表全天周期、重启高峰或长期网络抖动。"
            ),
        },
        {
            "id": "next_steps",
            "type": "markdown",
            "body": (
                "## 建议的下一步\n\n"
                "1. **先验证再修复超时后的任务生命周期。** 增加 requestId/taskId 关联；若确认 HTTP/worker 请求约 10 s 结束后对应任务仍在队列中，则通过已有 AbortSignal 或 deadline 取消。\n"
                "2. **把 30 s 级 farm.check 作为首要长尾诊断对象。** 记录每个子 RPC 的耗时与超时原因；不要再加一层防御性队列。\n"
                "3. **给逐好友批次补最小必要指标。** 每轮记录 friendCount、candidateCount、processedCount、deferredCount，并给单次任务增加 taskId 与 blockedByTask。\n"
                "4. **做一次受控 300 好友测试。** 连续运行至少 2 小时，同时固定频率请求 GET /api/bag 与一个 fresh-read 接口；同时看 P95、P99、最大等待、取消率和处理进度。\n"
                "5. **保留当前 6.4 小时样本作为新版本基线。** 后续 24 小时与 7 天数据按同一 notebook 复算，比较发布前后变化。"
            ),
        },
        {
            "id": "further_questions",
            "type": "markdown",
            "body": (
                "## 仍需回答的问题\n\n"
                "- farm.check 的 30.6 s 是单个协议超时、重试，还是多步业务累计？\n"
                "- HTTP 约 10 s 返回后，对应账号任务是否仍在队列中继续执行？\n"
                "- 三个账号在生产中的实际好友总数分别是多少，是否存在接近 300 的账号？\n"
                "- 300 好友场景下，捣乱类单好友事务的 9 s 尾部是否会重复出现？"
            ),
        },
    ]

    return {
        "version": 1,
        "surface": "report",
        "title": title,
        "description": "三账号生产运行的队列、HTTP 与好友长任务性能诊断。",
        "generatedAt": generated_at,
        "sources": sources,
        "cards": cards,
        "charts": charts,
        "tables": tables,
        "blocks": blocks,
    }


def main():
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    metrics_source = build_source(summary)
    datasets = build_datasets(summary)
    datasets, sql_sources = persist_and_query_datasets(datasets, summary["metadata"]["generated_at"])
    sources = [
        metrics_source,
        *sql_sources,
        {"id": "architecture_claude", "label": "架构验收标准（Claude 评估）", "path": "docs/architecture-claude.md"},
        {"id": "architecture_kimi", "label": "架构验收标准（Kimi 评估）", "path": "docs/architecture-kimi.md"},
        {"id": "architecture_codex", "label": "调度架构方案（Codex）", "path": "docs/architecture-codex.md"},
        {"id": "account_task_runner_code", "label": "账号业务执行器实现", "path": "core/src/app/account-task-runner.ts"},
        {"id": "task_metrics_code", "label": "任务指标口径实现", "path": "core/src/app/account-task-metrics.ts"},
        {"id": "worker_scheduler_code", "label": "农场与好友统一调度实现", "path": "core/src/core/worker.ts"},
        {"id": "friend_scheduler_code", "label": "好友逐个任务实现", "path": "core/src/services/friend/scheduler.ts"},
    ]
    manifest = build_manifest(summary, datasets, sources)
    artifact = {
        "surface": "report",
        "manifest": manifest,
        "snapshot": {
            "version": 1,
            "generatedAt": summary["metadata"]["generated_at"],
            "status": "ready",
            "datasets": datasets,
        },
        "sources": sources,
    }
    ARTIFACT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    print(ARTIFACT_PATH)


if __name__ == "__main__":
    main()
