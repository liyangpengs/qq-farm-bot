from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path


ANALYSIS_DIR = Path(__file__).resolve().parent
SUMMARY_PATH = ANALYSIS_DIR / "latest-analysis-summary.json"
OUTPUT_PATH = ANALYSIS_DIR / "latest-report-artifact.json"
SQLITE_PATH = ANALYSIS_DIR / "latest-report-source.sqlite"


def phase(summary: dict, name: str, priority: str = "scheduled") -> dict:
    return next(
        row
        for row in summary["phase_summary"]
        if row["name"] == name and row["priority"] == priority
    )


def metric_card(card_id: str, description: str, metrics: list[dict]) -> dict:
    return {
        "id": card_id,
        "dataset": "headline",
        "sourceId": "headline_sql",
        "description": description,
        "metrics": metrics,
    }


def bar_chart(
    chart_id: str,
    title: str,
    subtitle: str,
    question: str,
    rationale: str,
    dataset: str,
    x_field: str,
    x_label: str,
    y_field: str,
    y_label: str,
    unit: str,
    tooltip: list[dict],
    *,
    color_field: str | None = None,
    orientation: str = "horizontal",
) -> dict:
    encodings: dict = {
        "x": {"field": x_field, "type": "nominal", "label": x_label},
        "y": {"field": y_field, "type": "quantitative", "label": y_label, "unit": unit},
        "tooltip": tooltip,
    }
    if color_field:
        encodings["color"] = {"field": color_field, "type": "nominal", "label": "分位数"}
    return {
        "id": chart_id,
        "title": title,
        "subtitle": subtitle,
        "showDescription": True,
        "intent": "comparison",
        "question": question,
        "rationale": rationale,
        "comparisonContext": {
            "grain": "账号 × 分位数" if color_field else "性能路径",
            "unit": unit,
            "denominator": "对应观测样本",
        },
        "type": "bar",
        "dataset": dataset,
        "sourceId": f"{dataset}_sql",
        "encodings": encodings,
        "valueFormat": "number",
        "unit": unit,
        "layout": "full",
        "labels": {"values": "all"},
        "maxRows": 20,
        "settings": {
            "orientation": orientation,
            "grouping": "grouped" if color_field else "single",
            "sort": "none" if color_field else "descending",
            "showValues": True,
            **({"categoryLabelPolicy": "wrap"} if orientation == "horizontal" else {}),
        },
        "surface": {"surface": "card", "showControls": False, "viewMode": "visualization"},
    }


def write_sqlite(datasets: dict[str, list[dict]]) -> None:
    with sqlite3.connect(SQLITE_PATH) as connection:
        for table_name, rows in datasets.items():
            if not rows:
                continue
            columns = list(rows[0])
            column_types = []
            for column in columns:
                values = [row.get(column) for row in rows if row.get(column) is not None]
                if values and all(isinstance(value, (bool, int)) for value in values):
                    column_type = "INTEGER"
                elif values and all(isinstance(value, (bool, int, float)) for value in values):
                    column_type = "REAL"
                else:
                    column_type = "TEXT"
                column_types.append(column_type)
            connection.execute(f'DROP TABLE IF EXISTS "{table_name}"')
            definition = ", ".join(
                f'"{column}" {column_type}'
                for column, column_type in zip(columns, column_types)
            )
            connection.execute(f'CREATE TABLE "{table_name}" ({definition})')
            placeholders = ", ".join("?" for _ in columns)
            connection.executemany(
                f'INSERT INTO "{table_name}" VALUES ({placeholders})',
                [[row.get(column) for column in columns] for row in rows],
            )


def dataset_source(dataset: str, rows: list[dict], generated_at: str) -> dict:
    columns = list(rows[0])
    selected = ", ".join(f'"{column}"' for column in columns)
    return {
        "id": f"{dataset}_sql",
        "label": f"{dataset} 报告快照查询",
        "path": "docs/performance-analysis/latest-report-source.sqlite",
        "query": {
            "engine": "sqlite",
            "language": "sql",
            "sql": f'SELECT {selected} FROM "{dataset}"',
            "description": f"读取技术报告数据集 {dataset}。",
            "executed_at": generated_at,
            "tables_used": [dataset],
            "filters": ["由目标 buildSha 的匿名生产日志聚合生成"],
            "metric_definitions": [
                "任务 P95/P99 为合并直方图 nearest-rank 所在桶上界",
                "好友轮分位数为逐轮明细的精确 nearest-rank",
            ],
        },
    }


def build_artifact(summary: dict) -> dict:
    metadata = summary["metadata"]
    quality = summary["data_quality"]
    metrics = summary["instrumented_metrics"]
    friend = summary["friend_rounds"]
    friend_overall = friend["overall"]
    outcome = summary["outcome_consistency"]
    source = metadata["source"]
    generated_at = summary["generated_at"]
    build_sha = metadata["target_build_sha"]
    build_short = build_sha[:7]
    title = f"生产调度 {metadata['instrumented_coverage_hours']:.2f} 小时性能诊断（构建 {build_short}）"

    headline = [{
        "coverage_hours": metadata["instrumented_coverage_hours"],
        "build_records": metadata["post_record_count"],
        "queued_wait_p95_ms": metrics["queued_tasks"]["wait"]["p95_upper_ms"],
        "queued_wait_max_ms": metrics["queued_tasks"]["wait"]["max_ms"],
        "max_queue_depth": metrics["queued_tasks"]["max_queue_depth"],
        "interactive_wait_p95_ms": metrics["interactive_queued_tasks"]["wait"]["p95_upper_ms"],
        "interactive_wait_max_ms": metrics["interactive_queued_tasks"]["wait"]["max_ms"],
        "http_get_p95_ms": metrics["http_get"]["run"]["p95_upper_ms"],
        "http_get_p99_ms": metrics["http_get"]["run"]["p99_upper_ms"],
        "friend_duration_p95_ms": friend_overall["duration"]["p95_ms"],
        "friend_duration_max_ms": friend_overall["duration"]["max_ms"],
        "friend_count_max": friend_overall["friend_count"]["max"],
        "friend_target": 300,
    }]

    p95_paths = [
        {
            "metric": "真实队列等待",
            "p95_ms": metrics["queued_tasks"]["wait"]["p95_upper_ms"],
            "p99_ms": metrics["queued_tasks"]["wait"]["p99_upper_ms"],
            "max_ms": metrics["queued_tasks"]["wait"]["max_ms"],
            "n": metrics["queued_tasks"]["n"],
            "definition": "AccountTaskRunner inline=false 的 wait",
        },
        {
            "metric": "交互任务等待",
            "p95_ms": metrics["interactive_queued_tasks"]["wait"]["p95_upper_ms"],
            "p99_ms": metrics["interactive_queued_tasks"]["wait"]["p99_upper_ms"],
            "max_ms": metrics["interactive_queued_tasks"]["wait"]["max_ms"],
            "n": metrics["interactive_queued_tasks"]["n"],
            "definition": "交互优先级且实际入队的任务 wait",
        },
        {
            "metric": "HTTP GET 执行",
            "p95_ms": metrics["http_get"]["run"]["p95_upper_ms"],
            "p99_ms": metrics["http_get"]["run"]["p99_upper_ms"],
            "max_ms": metrics["http_get"]["run"]["max_ms"],
            "n": metrics["http_get"]["n"],
            "definition": "目标构建内 GET 请求总执行时间",
        },
        {
            "metric": "农场轮执行",
            "p95_ms": metrics["scheduler_farm"]["run"]["p95_upper_ms"],
            "p99_ms": metrics["scheduler_farm"]["run"]["p99_upper_ms"],
            "max_ms": metrics["scheduler_farm"]["run"]["max_ms"],
            "n": metrics["scheduler_farm"]["n"],
            "definition": "scheduler.farm-tick 的 run",
        },
        {
            "metric": "好友轮执行（精确）",
            "p95_ms": friend_overall["duration"]["p95_ms"],
            "p99_ms": friend_overall["duration"]["p99_ms"],
            "max_ms": friend_overall["duration"]["max_ms"],
            "n": friend_overall["round_samples"],
            "definition": "friendRounds 明细的精确 duration",
        },
    ]

    friend_by_account = {row["account"]: row for row in friend["per_account"]}
    cadence = []
    cadence_chart = []
    for account in summary["per_account_instrumented"]:
        friend_account = friend_by_account[account["account"]]
        cadence.append({
            "account": account["account"],
            "observed_hours": account["observed_hours"],
            "farm_rounds": account["scheduler_farm"]["n"],
            "farm_gap_mean_s": round(account["farm_start_gap_mean_approx_ms"] / 1000, 3),
            "friend_rounds": friend_account["round_samples"],
            "friend_gap_p50_s": round(friend_account["start_gap"]["p50_ms"] / 1000, 3),
            "friend_gap_p95_s": round(friend_account["start_gap"]["p95_ms"] / 1000, 3),
            "friend_duration_p95_ms": friend_account["duration"]["p95_ms"],
            "friend_duration_max_ms": friend_account["duration"]["max_ms"],
            "friend_count_max": friend_account["friend_count"]["max"],
            "candidates": friend_account["candidate_count"],
            "processed": friend_account["processed_count"],
            "deferred": friend_account["deferred_count"],
        })
        for percentile in ("P50", "P95"):
            cadence_chart.append({
                "account": account["account"],
                "percentile": percentile,
                "gap_seconds": round(friend_account["start_gap"][f"{percentile.lower()}_ms"] / 1000, 3),
                "rounds": friend_account["round_samples"],
                "friend_count_max": friend_account["friend_count"]["max"],
                "duration_p95_ms": friend_account["duration"]["p95_ms"],
            })

    selected_phases = [
        ("friend.phase.get-all-friends", "好友列表读取"),
        ("farm.phase.fertilize-smart", "smart 施肥阶段"),
        ("farm.phase.get-lands", "巡田首次土地读取"),
        ("farm.phase.post-fertilizer-get-lands", "施肥后成熟检查读取"),
    ]
    slow_samples = summary["slow_tasks"]["samples"]
    slow_counts = Counter(
        row["name"] for row in slow_samples if row["priority"] == "scheduled"
    )
    phase_evidence = []
    for task_name, label in selected_phases:
        row = phase(summary, task_name)
        phase_evidence.append({
            "phase": label,
            "task_name": task_name,
            "n": row["n"],
            "errors": row["errors"],
            "p95_ms": row["run"]["p95_upper_ms"],
            "p99_ms": row["run"]["p99_upper_ms"],
            "max_ms": row["run"]["max_ms"],
            "slow_samples": slow_counts[task_name],
        })

    outlier_phases = [row for row in phase_evidence if row["task_name"] != "farm.phase.post-fertilizer-get-lands"]
    outlier_chart = [
        {
            "phase": row["phase"],
            "max_seconds": round(row["max_ms"] / 1000, 3),
            "p95_ms": row["p95_ms"],
            "n": row["n"],
            "errors": row["errors"],
            "slow_samples": row["slow_samples"],
        }
        for row in outlier_phases
    ]

    slow_incident = [
        {
            "account": row["account"],
            "finished_at": row["finished_at"],
            "task": row["name"],
            "priority": row["priority"],
            "wait_s": round(row["wait_ms"] / 1000, 3),
            "run_s": round(row["run_ms"] / 1000, 3),
            "total_s": round(row["total_ms"] / 1000, 3),
            "blocked_by": row["blocked_by_task_name"] or "—",
            "outcome": row["outcome"],
        }
        for row in slow_samples[:12]
    ]

    previous_http = summary["previous_report_snapshot"]["metrics"]["http_get"]
    acceptance = [
        {
            "criterion": "真实队列常态等待",
            "observed": f"P95 ≤{metrics['queued_tasks']['wait']['p95_upper_ms']:.0f} ms；最大深度 {metrics['queued_tasks']['max_queue_depth']}",
            "status": "运行态达标",
            "reason": "30,323 次入队任务没有持续积压",
        },
        {
            "criterion": "交互任务可响应",
            "observed": f"P95 ≤{metrics['interactive_queued_tasks']['wait']['p95_upper_ms']:.0f} ms；最大 {metrics['interactive_queued_tasks']['wait']['max_ms'] / 1000:.3f} s",
            "status": "运行态达标",
            "reason": "仅 172 个真实交互入队样本，仍需更大样本复核",
        },
        {
            "criterion": "HTTP GET P95 不劣化",
            "observed": f"当前 ≤{metrics['http_get']['run']['p95_upper_ms']:.0f} ms；历史快照 ≤{previous_http['run_p95_upper_ms']:.0f} ms",
            "status": "未通过正式基准",
            "reason": "负载、路由组合与调度区间不一致，不能做严格 ±20% A/B",
        },
        {
            "criterion": "5 秒压力配置生效",
            "observed": "好友轮每账号 P50≈23.04 s；农场轮均值≈22.45–22.74 s",
            "status": "未生效",
            "reason": "行为仍符合 20–25 秒配置",
        },
        {
            "criterion": "300 好友生产覆盖",
            "observed": f"最大好友数 {friend_overall['friend_count']['max']}；目标 300",
            "status": "未覆盖",
            "reason": "不能由 18 好友样本外推 300 好友 P95",
        },
        {
            "criterion": "好友结果语义",
            "observed": f"明细 error={outcome['friend_round_detail_errors']}；scheduler error={outcome['scheduler_friend_errors']}",
            "status": "已闭环",
            "reason": "明细与包装器一致",
        },
        {
            "criterion": "农场结果语义",
            "observed": f"phase/farm.check error={outcome['farm_phase_errors']}/{outcome['farm_check_errors']}；scheduler error={outcome['scheduler_farm_errors']}",
            "status": "部署构建未闭环",
            "reason": "错误尚未传到 scheduler.farm-tick",
        },
    ]

    quality_rows = [
        {"check": "JSON 解析错误", "value": len(quality["parse_errors"]), "status": "通过"},
        {"check": "重复窗口", "value": quality["duplicate_rows"], "status": "通过"},
        {"check": "跨部署重叠窗口", "value": quality["overlap_record_count"], "status": "通过"},
        {"check": "目标构建记录", "value": metadata["post_record_count"], "status": "可用"},
        {"check": "排除的旧部署记录", "value": metadata["record_count"] - metadata["post_record_count"], "status": "已隔离"},
        {"check": "好友轮明细截断", "value": friend_overall["sample_truncation_n"], "status": "通过"},
        {"check": "schedulerIntervals 记录", "value": quality["records_with_scheduler_intervals"], "status": "旧构建未提供"},
        {"check": "friendListSources 记录", "value": quality["records_with_friend_list_sources"], "status": "旧构建未提供"},
    ]

    datasets = {
        "headline": headline,
        "p95_paths": p95_paths,
        "cadence": cadence,
        "cadence_chart": cadence_chart,
        "outlier_chart": outlier_chart,
        "slow_incident": slow_incident,
        "phase_evidence": phase_evidence,
        "acceptance": acceptance,
        "quality": quality_rows,
    }
    write_sqlite(datasets)

    sources = [
        {
            "id": "production_analysis",
            "label": "8 月 28–29 日生产调度日志合并分析",
            "path": "docs/performance-analysis/latest-analysis-summary.json",
            "query": {
                "engine": "python",
                "language": "python",
                "query": "py -3 docs/performance-analysis/analyze_latest_metrics.py",
                "description": "合并两份 JSONL，按最新 buildSha 隔离部署，聚合直方图并复算好友轮与慢任务明细。",
                "executed_at": generated_at,
                "tables_used": [item["file"] for item in source["files"]],
                "filters": [
                    f"仅纳入 buildSha={build_sha}",
                    f"有效窗口 {metadata['instrumented_coverage_start']} 至 {metadata['instrumented_coverage_end']}",
                    "账号仅以 A01–A03 别名展示",
                ],
                "metric_definitions": [
                    "任务 P95/P99 是合并直方图 nearest-rank 所在桶上界，因此正文使用 ≤",
                    "好友轮 duration/start gap 使用逐轮明细的精确 nearest-rank",
                    "真实队列等待仅统计 AccountTaskRunner 中 inline=false 的任务 waitMs",
                    "scheduler.* waitMs 是调度迟到，不是账号业务队列等待",
                ],
                "notes": [
                    f"组合来源 SHA-256: {source['sha256']}",
                    *[f"{item['file']}: {item['sha256']}" for item in source["files"]],
                ],
            },
        },
        {
            "id": "deployed_code",
            "label": f"部署构建 {build_short} 的农场代码",
            "href": f"https://github.com/ccpopy/qq-farm-bot/blob/{build_sha}/core/src/services/farm/planting.ts",
            "path": "core/src/services/farm/planting.ts",
            "query": {
                "engine": "git",
                "language": "shell",
                "query": f"git show {build_sha}:core/src/services/farm/planting.ts",
                "description": "核对 smart 施肥在部署构建中的土地读取路径。",
                "executed_at": generated_at,
            },
        },
        {
            "id": "local_validation",
            "label": "本地后端修正与验证",
            "path": "core/tests",
            "query": {
                "engine": "powershell",
                "language": "shell",
                "query": "pnpm -C core test; pnpm build; pnpm -C core exec eslint <changed-files>; git diff --check",
                "description": "验证 smart 土地快照、农场错误传播、好友列表来源指标、调度间隔指标与 300 好友切片。",
                "executed_at": generated_at,
                "notes": ["core tests 132/132 passed", "root production build passed", "changed-file ESLint and git diff --check passed"],
            },
        },
    ] + [dataset_source(dataset, rows, generated_at) for dataset, rows in datasets.items()]

    cards = [
        metric_card("coverage_card", "严格限定到目标构建后的连续观测窗口。", [
            {"label": "有效观测", "field": "coverage_hours", "format": "number", "unit": "h"},
            {"label": "记录", "field": "build_records", "format": "number"},
        ]),
        metric_card("queue_card", "真实账号任务队列，不含 inline 子阶段。", [
            {"label": "队列等待 P95", "field": "queued_wait_p95_ms", "format": "number", "unit": "ms"},
            {"label": "最大深度", "field": "max_queue_depth", "format": "number"},
            {"label": "最大等待", "field": "queued_wait_max_ms", "format": "number", "unit": "ms"},
        ]),
        metric_card("interactive_card", "交互优先级且实际进入账号队列的任务。", [
            {"label": "交互等待 P95", "field": "interactive_wait_p95_ms", "format": "number", "unit": "ms"},
            {"label": "最大", "field": "interactive_wait_max_ms", "format": "number", "unit": "ms"},
        ]),
        metric_card("http_card", "目标构建内全部 HTTP GET。", [
            {"label": "HTTP GET P95", "field": "http_get_p95_ms", "format": "number", "unit": "ms"},
            {"label": "P99", "field": "http_get_p99_ms", "format": "number", "unit": "ms"},
        ]),
        metric_card("friend_card", "好友轮使用逐轮明细精确分位数。", [
            {"label": "好友轮 P95", "field": "friend_duration_p95_ms", "format": "number", "unit": "ms"},
            {"label": "最大", "field": "friend_duration_max_ms", "format": "number", "unit": "ms"},
        ]),
        metric_card("friend_scope_card", "当前生产样本未覆盖大好友量账号。", [
            {"label": "最大好友数", "field": "friend_count_max", "format": "number"},
            {"label": "验收目标", "field": "friend_target", "format": "number"},
        ]),
    ]

    charts = [
        bar_chart(
            "p95_chart",
            "关键路径 P95 延迟",
            "常态分位数低，但 P95 不代表极少数 20–90 秒上游停顿",
            "重构后的常态排队与执行延迟是否健康？",
            "同一毫秒单位的横向条形图便于比较不同路径。",
            "p95_paths",
            "metric",
            "路径",
            "p95_ms",
            "P95",
            "ms",
            [
                {"field": "p99_ms", "type": "quantitative", "label": "P99", "unit": "ms"},
                {"field": "max_ms", "type": "quantitative", "label": "最大", "unit": "ms"},
                {"field": "n", "type": "quantitative", "label": "样本"},
                {"field": "definition", "type": "nominal", "label": "定义"},
            ],
        ),
        bar_chart(
            "cadence_chart",
            "每账号好友轮启动间隔",
            "三个账号的 P50/P95 均约为 23/25 秒，没有形成 5 秒压力",
            "用户设置的 5 秒间隔是否实际生效？",
            "分组柱形图同时展示每账号 P50 与 P95。",
            "cadence_chart",
            "account",
            "账号",
            "gap_seconds",
            "启动间隔",
            "s",
            [
                {"field": "rounds", "type": "quantitative", "label": "轮次"},
                {"field": "friend_count_max", "type": "quantitative", "label": "最大好友数"},
                {"field": "duration_p95_ms", "type": "quantitative", "label": "轮耗时 P95", "unit": "ms"},
            ],
            color_field="percentile",
            orientation="vertical",
        ),
        bar_chart(
            "outlier_chart",
            "关键后台阶段最大耗时",
            "17:33–17:40 的好友列表停顿与 smart 重复土地读取构成长尾",
            "极端长尾具体集中在哪些阶段？",
            "排序横向条形图比较同一秒单位的阶段最大值。",
            "outlier_chart",
            "phase",
            "阶段",
            "max_seconds",
            "最大耗时",
            "s",
            [
                {"field": "p95_ms", "type": "quantitative", "label": "P95", "unit": "ms"},
                {"field": "n", "type": "quantitative", "label": "样本"},
                {"field": "errors", "type": "quantitative", "label": "错误"},
                {"field": "slow_samples", "type": "quantitative", "label": "慢样本"},
            ],
        ),
    ]

    tables = [
        {
            "id": "acceptance_table",
            "title": "架构验收项状态",
            "subtitle": "运行态健康不等于正式基准通过；未覆盖项单独标识",
            "showDescription": True,
            "dataset": "acceptance",
            "sourceId": "acceptance_sql",
            "defaultSort": {"field": "criterion", "direction": "asc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "criterion", "label": "验收项", "type": "text"},
                {"field": "observed", "label": "观测", "type": "text"},
                {"field": "status", "label": "状态", "type": "text"},
                {"field": "reason", "label": "判断依据", "type": "text"},
            ],
        },
        {
            "id": "cadence_table",
            "title": "每账号调度节奏与好友规模",
            "subtitle": "20.0 小时左右的独立账号窗口；农场间隔为窗口时长/轮次数近似值",
            "showDescription": True,
            "dataset": "cadence",
            "sourceId": "cadence_sql",
            "defaultSort": {"field": "account", "direction": "asc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "account", "label": "账号", "type": "text"},
                {"field": "observed_hours", "label": "小时", "format": "number"},
                {"field": "farm_rounds", "label": "农场轮", "format": "number"},
                {"field": "farm_gap_mean_s", "label": "农场均值间隔 s", "format": "number"},
                {"field": "friend_rounds", "label": "好友轮", "format": "number"},
                {"field": "friend_gap_p50_s", "label": "好友间隔 P50 s", "format": "number"},
                {"field": "friend_gap_p95_s", "label": "好友间隔 P95 s", "format": "number"},
                {"field": "friend_duration_p95_ms", "label": "好友耗时 P95 ms", "format": "number"},
                {"field": "friend_count_max", "label": "最大好友数", "format": "number"},
            ],
        },
        {
            "id": "slow_incident_table",
            "title": "最长慢任务因果样本",
            "subtitle": "按总耗时降序；blocked_by 是提交时正在占用同账号执行槽的任务",
            "showDescription": True,
            "dataset": "slow_incident",
            "sourceId": "slow_incident_sql",
            "defaultSort": {"field": "total_s", "direction": "desc"},
            "density": "dense",
            "layout": "full",
            "columns": [
                {"field": "account", "label": "账号", "type": "text"},
                {"field": "finished_at", "label": "完成时间", "type": "text"},
                {"field": "task", "label": "任务", "type": "text"},
                {"field": "wait_s", "label": "等待 s", "format": "number"},
                {"field": "run_s", "label": "运行 s", "format": "number"},
                {"field": "total_s", "label": "总耗时 s", "format": "number"},
                {"field": "blocked_by", "label": "被谁阻塞", "type": "text"},
                {"field": "outcome", "label": "结果", "type": "text"},
            ],
        },
        {
            "id": "phase_table",
            "title": "土地与好友列表阶段证据",
            "subtitle": "仅 scheduled 优先级；P95/P99 是直方图桶上界",
            "showDescription": True,
            "dataset": "phase_evidence",
            "sourceId": "phase_evidence_sql",
            "defaultSort": {"field": "max_ms", "direction": "desc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "phase", "label": "阶段", "type": "text"},
                {"field": "n", "label": "样本", "format": "number"},
                {"field": "errors", "label": "错误", "format": "number"},
                {"field": "p95_ms", "label": "P95 ms", "format": "number"},
                {"field": "p99_ms", "label": "P99 ms", "format": "number"},
                {"field": "max_ms", "label": "最大 ms", "format": "number"},
                {"field": "slow_samples", "label": "慢样本", "format": "number"},
            ],
        },
        {
            "id": "quality_table",
            "title": "数据质量与新增字段覆盖",
            "subtitle": "旧部署记录被排除；下一轮新增字段当前为 0 属预期",
            "showDescription": True,
            "dataset": "quality",
            "sourceId": "quality_sql",
            "defaultSort": {"field": "check", "direction": "asc"},
            "density": "spacious",
            "layout": "full",
            "columns": [
                {"field": "check", "label": "检查", "type": "text"},
                {"field": "value", "label": "值", "format": "number"},
                {"field": "status", "label": "状态", "type": "text"},
            ],
        },
    ]

    technical_summary = (
        "## 技术结论\n\n"
        f"**常态路径没有持续堵塞。** 目标构建共覆盖 {metadata['instrumented_coverage_hours']:.3f} 小时、"
        f"{metrics['queued_tasks']['n']:,} 次真实入队任务；队列等待 P95 ≤{metrics['queued_tasks']['wait']['p95_upper_ms']:.0f} ms，"
        f"最大队列深度 {metrics['queued_tasks']['max_queue_depth']}。交互任务等待 P95 ≤{metrics['interactive_queued_tasks']['wait']['p95_upper_ms']:.0f} ms，"
        f"HTTP GET 执行 P95 ≤{metrics['http_get']['run']['p95_upper_ms']:.0f} ms。\n\n"
        "**但一开始提出的正式生产验收尚不能标记为通过。** 实际好友轮每账号 P50 约 23.04 秒，"
        "农场轮平均约 22.45–22.74 秒，说明本轮不是 5 秒压力；三个账号最大好友数只有 18，也没有覆盖 300 好友场景。\n\n"
        f"**长尾不是持续排队，而是少数上游请求停顿。** 8 月 28 日 17:33–17:40，三个账号的好友列表读取同时出现约 54.7–62.5 秒停顿，"
        f"并把后续农场任务最长等待拉到 {metrics['queued_tasks']['wait']['max_ms'] / 1000:.3f} 秒。"
        f"smart 施肥阶段另有 {slow_counts['farm.phase.fertilize-smart']} 个慢样本，最大 {phase(summary, 'farm.phase.fertilize-smart')['run']['max_ms'] / 1000:.3f} 秒。"
    )

    blocks = [
        {"id": "title", "type": "markdown", "body": f"# {title}"},
        {"id": "technical_summary", "type": "markdown", "sourceId": "production_analysis", "body": technical_summary},
        {"id": "headline_metrics", "type": "metric-strip", "cardIds": [card["id"] for card in cards]},
        {
            "id": "normal_path",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 常态路径满足低排队目标，但正式基线仍不能判定通过\n\n"
                "真实队列、交互等待、HTTP GET、农场轮和好友轮的 P95 都处于毫秒到亚秒级。图中好友轮使用逐轮精确分位数，"
                "其余使用保守的直方图桶上界。P95 的健康不抵消极端长尾，因此最大值与 P99 同时保留在图表明细中。\n\n"
                f"历史快照的 HTTP GET P95 为 ≤{previous_http['run_p95_upper_ms']:.0f} ms，当前为 ≤{metrics['http_get']['run']['p95_upper_ms']:.0f} ms；"
                "两轮负载与路由组合不同，旧原始文件又被同名下载覆盖，不能把这组差异当作严格回归结论，也不能据此宣称满足 ±20% 基准。"
            ),
        },
        {"id": "p95_chart_block", "type": "chart", "chartId": "p95_chart"},
        {"id": "acceptance_block", "type": "table", "tableId": "acceptance_table"},
        {
            "id": "cadence_result",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 实际运行是 20–25 秒节奏，不是 5 秒压力\n\n"
                "A01、A02、A03 的好友轮启动间隔 P50 分别为 23.043、23.042、23.044 秒，P95 约 25.1 秒；"
                "农场轮按观测时长除以轮次数估算，也稳定在 22.45–22.74 秒。"
                "这与原有 20–25 秒随机区间一致，因此本轮不能用于验收 5 秒配置下的容量。\n\n"
                "每账号最大好友数分别为 18、8、8。当前切片机制在代码测试中覆盖了 300 好友可让步与可中止，但生产日志只证明 18 好友以内的实际表现。"
            ),
        },
        {"id": "cadence_chart_block", "type": "chart", "chartId": "cadence_chart"},
        {"id": "cadence_table_block", "type": "table", "tableId": "cadence_table"},
        {
            "id": "outlier_result",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 主要长尾来自跨账号同时发生的上游停顿\n\n"
                "8 月 28 日 17:33–17:40，A01–A03 的 `friend.phase.get-all-friends` 都出现 54.7–62.5 秒运行时间。"
                "同一时段的后续 `farm.check` 被这些任务占用同账号执行槽，最长等待 56.319 秒。"
                "队列最大深度仍只有 2，说明这是少数长任务导致的瞬时阻塞，而不是任务持续堆积。\n\n"
                "处理重点应是减少重复上游读取、复用短 TTL 结果并保留单好友切片；继续堆叠队列保护或扩大并发不会消除这一类上游停顿。"
            ),
        },
        {"id": "outlier_chart_block", "type": "chart", "chartId": "outlier_chart"},
        {"id": "slow_incident_block", "type": "table", "tableId": "slow_incident_table"},
        {
            "id": "smart_fertilizer_result",
            "type": "markdown",
            "body": (
                "## 部署构建中的 smart 施肥仍重复读取土地\n\n"
                f"目标构建共记录 {phase(summary, 'farm.phase.get-lands')['n']:,} 次巡田首次土地读取和 "
                f"{phase(summary, 'farm.phase.fertilize-smart')['n']:,} 次 smart 施肥阶段。"
                "结合 [部署构建代码](https://github.com/ccpopy/qq-farm-bot/blob/"
                f"{build_sha}/core/src/services/farm/planting.ts) 可确认：smart 阶段进入后还会再次读取土地。"
                f"必要的施肥后成熟检查读取只有 {phase(summary, 'farm.phase.post-fertilizer-get-lands')['n']} 次，不能解释近乎每轮出现的第二次读取。\n\n"
                "本地修正只在本轮未发生土地写操作时复用最初的实时快照；一旦尝试务农、收获、种植、多季补肥、解锁或升级，"
                "smart 判断仍强制重新读取。smart 有机肥成功后的成熟检查也继续实时重读，因此不会牺牲施肥所需的新鲜状态。"
            ),
        },
        {"id": "phase_table_block", "type": "table", "tableId": "phase_table"},
        {
            "id": "scope",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 范围、数据与指标定义\n\n"
                f"两份文件合计 {metadata['record_count']} 条记录，覆盖 {metadata['coverage_start']} 至 {metadata['coverage_end']}。"
                f"分析严格限定到最新 `buildSha={build_sha}` 的 {metadata['post_record_count']} 条记录，"
                f"有效窗口为 {metadata['instrumented_coverage_start']} 至 {metadata['instrumented_coverage_end']}（Asia/Shanghai）。\n\n"
                "任务 P50/P95/P99 来自五分钟窗口直方图的 nearest-rank 桶上界，正文用“≤”表达；好友轮 duration 与启动间隔来自逐轮明细。"
                "`scheduler.*.wait` 是调度到期后的迟到，不等于 AccountTaskRunner 的真实队列等待；正式排队判断只使用 `inline=false` 的账号任务。"
            ),
        },
        {"id": "quality_block", "type": "table", "tableId": "quality_table"},
        {
            "id": "methodology",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 复算方法按部署、账号与任务语义分层\n\n"
                "分析逐行解析 JSONL，先校验延迟桶边界、重复窗口和跨部署重叠，再按最新 buildSha 过滤。"
                "任务统计按 execution 数合并直方图；好友轮和慢任务使用完整明细；账号 ID 在产物中仅保留 A01–A03 别名。"
                "关键结论又通过原始慢任务样本复核：好友列表长运行与农场等待之间存在同账号 `blockedByTaskName` 直接关系。"
            ),
        },
        {
            "id": "limitations",
            "type": "markdown",
            "sourceId": "production_analysis",
            "body": (
                "## 局限、稳健性与尚未闭环项\n\n"
                "- 当前生产好友规模最大为 18，不能推断 300 好友时的总耗时、候选规模或 P95。\n"
                "- 5 秒间隔实际未生效，不能把本轮称为 5 秒压力测试。\n"
                "- 200 条旧记录没有 buildSha，已全部排除；历史快照的同名原始文件被覆盖，基线只能作方向参考。\n"
                "- 当前构建没有 `schedulerIntervals` 与 `friendListSources`，因此配置值和好友列表命中来源只能靠行为推断；下一轮日志会直接记录。\n"
                f"- 农场 phase 和 `farm.check` 都有 {outcome['farm_check_errors']} 次错误，但 `scheduler.farm-tick` 仍为 0；部署构建的结果链路尚未闭环。"
            ),
        },
        {
            "id": "prepared_changes",
            "type": "markdown",
            "sourceId": "local_validation",
            "body": (
                "## 针对本轮证据的后端修正已完成本地验证\n\n"
                "- smart 施肥在无土地写操作时复用本轮初始实时快照；任何可能写土地的操作都会使快照失效。\n"
                "- `farm.check` 错误继续传播到 `scheduler.farm-tick`，保留原有布尔调用兼容性。\n"
                "- 好友列表读取增加 `network`、`cache`、`singleflight`、`unknown` 来源统计；性能日志增加实际调度配置区间。\n"
                "- 300 好友扫描继续按单好友切片，交互和农场任务可在两位好友之间插入，且中止后不会继续展开剩余好友。\n\n"
                "完整 core 测试 132/132 通过，根目录生产构建通过，改动文件 ESLint 与 `git diff --check` 通过。"
            ),
        },
        {
            "id": "next_steps",
            "type": "markdown",
            "body": (
                "## 下一轮应以可验证条件重新监听\n\n"
                "1. 部署本地修正后重启服务，确认日志中的 buildSha 已变化。\n"
                "2. 通过新增 `schedulerIntervals` 直接确认农场与好友是否确实配置为 5 秒，不再仅靠轮次反推。\n"
                "3. 连续运行至少 6 小时，并保留自然后台任务与页面刷新；报告同时比较 `friendListSources`、smart 阶段长尾和农场错误传播。\n"
                "4. 另用真实 300 好友账号或固定负载工具完成 300 好友验收；在生产好友数仍低于 300 时，明确保持“未覆盖”，不做外推。"
            ),
        },
        {
            "id": "further_questions",
            "type": "markdown",
            "body": (
                "## 仍需回答的问题\n\n"
                "- 5 秒是账号设置未保存、服务未重启，还是只修改了页面刷新频率？新增配置快照可直接区分。\n"
                "- 300 好友账号中实际有多少候选需要逐个 Enter，经验上限与黑名单会把多少候选提前过滤？\n"
                "- 17:33–17:40 的跨账号停顿来自游戏上游、网关 pending/queued，还是宿主网络瞬时抖动？当前日志只足以定位到好友列表读取阶段。"
            ),
        },
    ]

    snapshot = {
        "version": 1,
        "status": "ready",
        "generatedAt": generated_at,
        "datasets": datasets,
    }
    manifest = {
        "version": 1,
        "surface": "report",
        "title": title,
        "description": "按最新部署隔离的多账号生产调度性能、长尾归因与后端修正验证。",
        "generatedAt": generated_at,
        "blocks": blocks,
        "cards": cards,
        "charts": charts,
        "tables": tables,
        "sources": sources,
    }
    return {"surface": "report", "manifest": manifest, "snapshot": snapshot, "sources": sources}


def main() -> None:
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    artifact = build_artifact(summary)
    OUTPUT_PATH.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
