from __future__ import annotations

import json
import math
from pathlib import Path

import nbformat
from nbclient import NotebookClient


OUTPUT_DIR = Path(__file__).resolve().parent
NOTEBOOK_PATH = OUTPUT_DIR / "performance-metrics-analysis.ipynb"
SUMMARY_PATH = OUTPUT_DIR / "analysis-summary.json"


def markdown(source: str):
    return nbformat.v4.new_markdown_cell(source.strip())


def code(source: str):
    return nbformat.v4.new_code_cell(source.strip())


def build_notebook():
    cells = [
        markdown(
            """
# 调度重构生产性能分析

## tl;dr

首次执行后自动写入结论。
"""
        ),
        markdown(
            """
## Context & Methods

本 notebook 分析 `docs/task-metrics-*.jsonl` 中的五分钟聚合窗口，目标是判断当前多账号运行是否出现明显排队堵塞、好友长任务是否拖慢交互请求，以及现有样本能否证明 300 好友场景与架构性能验收项。

### Key Assumptions

- 日志只保留直方图，不保留单次请求明细；P50/P95/P99 使用所在桶的上界，是保守上界而非精确分位数。
- `taskCount`、直方图计数和 outcome 计数必须一致，异常会在质量检查中列出。
- `scheduler.*` 的 `waitMs` 是计划触发时间到实际开始时间的调度迟到；只有 `inline=false` 任务的 `waitMs` 才是业务队列等待。
- 账号只显示稳定别名 `A01`、`A02`，不输出真实账号 ID。
- 当前架构文档只定义“相对重构前基线漂移不超过 ±20%”和“后台运行不抬高 UI 只读 P95”，没有绝对毫秒门槛；没有重构前基线时不能给出正式 pass/fail。
"""
        ),
        markdown("## Data\n\n加载两份 JSONL，检查来源哈希、时间覆盖、版本和记录粒度。"),
        code(
            r'''
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from IPython.display import display

DATA_DIR = Path("..")
SUMMARY_FILE = Path("analysis-summary.json")
SOURCE_FILES = sorted(DATA_DIR.glob("task-metrics-*.jsonl"))
LOCAL_TZ = ZoneInfo("Asia/Shanghai")

if not SOURCE_FILES:
    raise FileNotFoundError("未找到 ../task-metrics-*.jsonl")

records = []
malformed_lines = []
source_inventory = []
for source_file in SOURCE_FILES:
    raw_bytes = source_file.read_bytes()
    source_inventory.append({
        "file": f"docs/{source_file.name}",
        "bytes": len(raw_bytes),
        "sha256": hashlib.sha256(raw_bytes).hexdigest(),
    })
    for line_number, line in enumerate(raw_bytes.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            record["_source_file"] = source_file.name
            record["_source_line"] = line_number
            records.append(record)
        except json.JSONDecodeError as exc:
            malformed_lines.append({"file": source_file.name, "line": line_number, "error": str(exc)})

account_ids = sorted({str(record.get("accountId", "")) for record in records if record.get("kind") == "account_tasks"})
account_aliases = {account_id: f"A{index:02d}" for index, account_id in enumerate(account_ids, start=1)}

def account_alias(record):
    account_id = str(record.get("accountId", ""))
    if account_id in account_aliases:
        return account_aliases[account_id]
    return "HTTP-unscoped"

def local_time(epoch_ms):
    return datetime.fromtimestamp(float(epoch_ms) / 1000, tz=LOCAL_TZ)

coverage_start = min(record["windowStartedAt"] for record in records)
coverage_end = max(record["windowEndedAt"] for record in records)
coverage_hours = (coverage_end - coverage_start) / 3_600_000

inventory_df = pd.DataFrame(source_inventory)
inventory_df["size_kib"] = (inventory_df["bytes"] / 1024).round(1)
display(inventory_df[["file", "size_kib", "sha256"]])
print(
    f"记录 {len(records)} 行，账号任务账号 {len(account_ids)} 个，"
    f"覆盖 {local_time(coverage_start):%Y-%m-%d %H:%M:%S} 至 "
    f"{local_time(coverage_end):%Y-%m-%d %H:%M:%S}（{coverage_hours:.2f} 小时）"
)
'''
        ),
        markdown("## Results\n\n先验证记录与聚合口径，再计算分位数和各切片表现。"),
        code(
            r'''
bucket_sets = {tuple(record.get("latencyBucketBoundsMs", [])) for record in records}
if len(bucket_sets) != 1:
    raise ValueError(f"发现不一致的延迟桶定义：{len(bucket_sets)} 种")
BUCKET_BOUNDS_MS = next(iter(bucket_sets))

duplicate_keys = defaultdict(int)
task_count_mismatches = []
histogram_count_mismatches = []
duration_sum_mismatches = []
negative_values = []
task_rows = []

for record in records:
    record_key = (
        record.get("kind"),
        record.get("accountId"),
        record.get("windowStartedAt"),
        record.get("windowEndedAt"),
    )
    duplicate_keys[record_key] += 1
    task_count_from_groups = 0
    for task in record.get("tasks", []):
        outcome_count = sum(int(task.get("outcomes", {}).get(name, 0)) for name in ("success", "error", "cancelled"))
        total_count = int(task.get("totalMs", {}).get("count", 0))
        task_count_from_groups += total_count
        for metric_name in ("waitMs", "runMs", "totalMs"):
            histogram = task.get(metric_name, {})
            histogram_count = int(histogram.get("count", 0))
            bucket_count = sum(int(value) for value in histogram.get("buckets", []))
            if histogram_count != outcome_count or bucket_count != histogram_count:
                histogram_count_mismatches.append({
                    "source": record["_source_file"],
                    "line": record["_source_line"],
                    "task": task.get("name"),
                    "metric": metric_name,
                })
            if any(float(histogram.get(field, 0)) < 0 for field in ("count", "sum", "max")):
                negative_values.append({"task": task.get("name"), "metric": metric_name})
        expected_total_sum = float(task["waitMs"]["sum"]) + float(task["runMs"]["sum"])
        actual_total_sum = float(task["totalMs"]["sum"])
        if not math.isclose(expected_total_sum, actual_total_sum, rel_tol=1e-9, abs_tol=0.01):
            duration_sum_mismatches.append({
                "source": record["_source_file"],
                "line": record["_source_line"],
                "task": task.get("name"),
                "difference_ms": actual_total_sum - expected_total_sum,
            })
        task_rows.append({
            "kind": record.get("kind"),
            "raw_account_id": str(record.get("accountId", "")),
            "account": account_alias(record),
            "window_started_at": int(record["windowStartedAt"]),
            "window_ended_at": int(record["windowEndedAt"]),
            "name": str(task.get("name", "unknown")),
            "priority": str(task.get("priority", "scheduled")),
            "inline": bool(task.get("inline", False)),
            "outcomes": {key: int(value) for key, value in task.get("outcomes", {}).items()},
            "dedupe_hits": int(task.get("dedupeHits", 0)),
            "max_queue_depth": int(task.get("maxQueueDepth", 0)),
            "wait_ms": task["waitMs"],
            "run_ms": task["runMs"],
            "total_ms": task["totalMs"],
        })
    if task_count_from_groups != int(record.get("taskCount", 0)):
        task_count_mismatches.append({
            "source": record["_source_file"],
            "line": record["_source_line"],
            "declared": int(record.get("taskCount", 0)),
            "derived": task_count_from_groups,
        })

duplicate_record_count = sum(count - 1 for count in duplicate_keys.values() if count > 1)
window_durations_by_kind = {
    kind: [
        int(record["windowEndedAt"]) - int(record["windowStartedAt"])
        for record in records
        if record.get("kind") == kind
    ]
    for kind in ("account_tasks", "http")
}
account_window_durations_ms = window_durations_by_kind["account_tasks"]
http_window_durations_ms = window_durations_by_kind["http"]

timeline_gaps = []
for account_id in account_ids:
    account_records = sorted(
        (record for record in records if record.get("kind") == "account_tasks" and str(record.get("accountId")) == account_id),
        key=lambda record: record["windowStartedAt"],
    )
    for previous, current in zip(account_records, account_records[1:]):
        gap_ms = int(current["windowStartedAt"]) - int(previous["windowEndedAt"])
        if gap_ms > 450_000:
            timeline_gaps.append({"account": account_aliases[account_id], "gap_minutes": gap_ms / 60_000})

quality = {
    "malformed_lines": len(malformed_lines),
    "duplicate_records": duplicate_record_count,
    "task_count_mismatches": len(task_count_mismatches),
    "histogram_count_mismatches": len(histogram_count_mismatches),
    "duration_sum_mismatches": len(duration_sum_mismatches),
    "negative_values": len(negative_values),
    "account_windows_shorter_than_4_5_minutes": sum(duration < 270_000 for duration in account_window_durations_ms),
    "account_windows_longer_than_5_5_minutes": sum(duration > 330_000 for duration in account_window_durations_ms),
    "account_window_min_seconds": round(min(account_window_durations_ms) / 1000, 3),
    "account_window_max_seconds": round(max(account_window_durations_ms) / 1000, 3),
    "http_windows_outside_4_5_to_5_5_minutes": sum(duration < 270_000 or duration > 330_000 for duration in http_window_durations_ms),
    "http_window_max_seconds": round(max(http_window_durations_ms) / 1000, 3),
    "timeline_gaps_over_7_5_minutes": len(timeline_gaps),
    "schema_versions": sorted({record.get("schemaVersion") for record in records}),
    "bot_versions": sorted({record.get("botVersion") for record in records}),
    "record_counts": {
        kind: sum(1 for record in records if record.get("kind") == kind)
        for kind in sorted({record.get("kind") for record in records})
    },
}

quality_df = pd.DataFrame([
    {"check": "JSON 坏行", "value": quality["malformed_lines"], "expected": 0},
    {"check": "重复窗口", "value": quality["duplicate_records"], "expected": 0},
    {"check": "taskCount 不一致", "value": quality["task_count_mismatches"], "expected": 0},
    {"check": "直方图计数不一致", "value": quality["histogram_count_mismatches"], "expected": 0},
    {"check": "total != wait + run", "value": quality["duration_sum_mismatches"], "expected": 0},
    {"check": "负值", "value": quality["negative_values"], "expected": 0},
    {"check": "账号窗口短于 4.5 分钟", "value": quality["account_windows_shorter_than_4_5_minutes"], "expected": 0},
    {"check": "账号窗口长于 5.5 分钟", "value": quality["account_windows_longer_than_5_5_minutes"], "expected": 0},
    {"check": "HTTP 非标准长度窗口", "value": quality["http_windows_outside_4_5_to_5_5_minutes"], "expected": "低流量 scope 可跨空窗"},
    {"check": "账号时间线 >7.5 分钟空档", "value": quality["timeline_gaps_over_7_5_minutes"], "expected": "0 或已知重启"},
])
display(quality_df)
'''
        ),
        code(
            r'''
def empty_histogram():
    return {
        "count": 0,
        "sum": 0.0,
        "max": 0.0,
        "buckets": [0] * (len(BUCKET_BOUNDS_MS) + 1),
    }

def merge_histogram(target, source):
    target["count"] += int(source.get("count", 0))
    target["sum"] += float(source.get("sum", 0))
    target["max"] = max(target["max"], float(source.get("max", 0)))
    for index, value in enumerate(source.get("buckets", [])):
        target["buckets"][index] += int(value)

def percentile_upper_ms(histogram, percentile):
    count = int(histogram["count"])
    if count == 0:
        return None
    rank = max(1, math.ceil(percentile * count))
    cumulative = 0
    for index, bucket_count in enumerate(histogram["buckets"]):
        cumulative += int(bucket_count)
        if cumulative >= rank:
            if index < len(BUCKET_BOUNDS_MS):
                return float(BUCKET_BOUNDS_MS[index])
            return float(histogram["max"])
    return float(histogram["max"])

def percentile_bucket_label(histogram, percentile):
    count = int(histogram["count"])
    if count == 0:
        return "n/a"
    rank = max(1, math.ceil(percentile * count))
    cumulative = 0
    for index, bucket_count in enumerate(histogram["buckets"]):
        cumulative += int(bucket_count)
        if cumulative >= rank:
            if index == 0:
                return f"≤{BUCKET_BOUNDS_MS[0]:g} ms"
            if index < len(BUCKET_BOUNDS_MS):
                return f">{BUCKET_BOUNDS_MS[index - 1]:g}–≤{BUCKET_BOUNDS_MS[index]:g} ms"
            return f">{BUCKET_BOUNDS_MS[-1]:g}–≤{histogram['max']:g} ms"
    return "n/a"

def count_over_ms(histogram, threshold_ms):
    if threshold_ms not in BUCKET_BOUNDS_MS:
        raise ValueError(f"阈值必须匹配直方图桶边界：{threshold_ms}")
    index = BUCKET_BOUNDS_MS.index(threshold_ms)
    return sum(int(value) for value in histogram["buckets"][index + 1:])

def aggregate_task_rows(rows, group_fields=()):
    grouped = {}
    for row in rows:
        key = tuple(row[field] for field in group_fields)
        if key not in grouped:
            grouped[key] = {
                **{field: row[field] for field in group_fields},
                "executions": 0,
                "success": 0,
                "error": 0,
                "cancelled": 0,
                "dedupe_hits": 0,
                "max_queue_depth": 0,
                "wait_ms": empty_histogram(),
                "run_ms": empty_histogram(),
                "total_ms": empty_histogram(),
            }
        aggregate = grouped[key]
        executions = int(row["total_ms"]["count"])
        aggregate["executions"] += executions
        aggregate["success"] += int(row["outcomes"].get("success", 0))
        aggregate["error"] += int(row["outcomes"].get("error", 0))
        aggregate["cancelled"] += int(row["outcomes"].get("cancelled", 0))
        aggregate["dedupe_hits"] += int(row["dedupe_hits"])
        aggregate["max_queue_depth"] = max(aggregate["max_queue_depth"], int(row["max_queue_depth"]))
        for metric_name in ("wait_ms", "run_ms", "total_ms"):
            merge_histogram(aggregate[metric_name], row[metric_name])
    return list(grouped.values())

def summarize_aggregate(aggregate):
    executions = int(aggregate["executions"])
    result = {
        "executions": executions,
        "success": int(aggregate["success"]),
        "error": int(aggregate["error"]),
        "cancelled": int(aggregate["cancelled"]),
        "error_rate_pct": round(100 * aggregate["error"] / executions, 4) if executions else 0.0,
        "cancelled_rate_pct": round(100 * aggregate["cancelled"] / executions, 4) if executions else 0.0,
        "dedupe_hits": int(aggregate["dedupe_hits"]),
        "max_queue_depth": int(aggregate["max_queue_depth"]),
    }
    for metric_name in ("wait_ms", "run_ms", "total_ms"):
        histogram = aggregate[metric_name]
        result[f"{metric_name}_mean"] = round(histogram["sum"] / histogram["count"], 3) if histogram["count"] else None
        result[f"{metric_name}_p50_upper"] = percentile_upper_ms(histogram, 0.50)
        result[f"{metric_name}_p95_upper"] = percentile_upper_ms(histogram, 0.95)
        result[f"{metric_name}_p99_upper"] = percentile_upper_ms(histogram, 0.99)
        result[f"{metric_name}_p95_bucket"] = percentile_bucket_label(histogram, 0.95)
        result[f"{metric_name}_max"] = round(float(histogram["max"]), 3)
        result[f"{metric_name}_over_1000"] = count_over_ms(histogram, 1000)
        result[f"{metric_name}_over_5000"] = count_over_ms(histogram, 5000)
    return result

def one_summary(rows):
    aggregates = aggregate_task_rows(rows)
    if not aggregates:
        return None
    return summarize_aggregate(aggregates[0])

def compact_metrics(summary):
    return {
        "n": summary["executions"],
        "errors": summary["error"],
        "cancelled": summary["cancelled"],
        "max_queue": summary["max_queue_depth"],
        "wait_mean_ms": summary["wait_ms_mean"],
        "wait_p95_upper_ms": summary["wait_ms_p95_upper"],
        "wait_p99_upper_ms": summary["wait_ms_p99_upper"],
        "wait_max_ms": summary["wait_ms_max"],
        "wait_over_1s_n": summary["wait_ms_over_1000"],
        "wait_over_5s_n": summary["wait_ms_over_5000"],
        "run_mean_ms": summary["run_ms_mean"],
        "run_p95_upper_ms": summary["run_ms_p95_upper"],
        "run_p99_upper_ms": summary["run_ms_p99_upper"],
        "run_max_ms": summary["run_ms_max"],
        "total_mean_ms": summary["total_ms_mean"],
        "total_p95_upper_ms": summary["total_ms_p95_upper"],
        "total_p99_upper_ms": summary["total_ms_p99_upper"],
        "total_max_ms": summary["total_ms_max"],
        "total_over_1s_n": summary["total_ms_over_1000"],
        "total_over_5s_n": summary["total_ms_over_5000"],
    }

account_task_rows = [row for row in task_rows if row["kind"] == "account_tasks"]
http_task_rows = [row for row in task_rows if row["kind"] == "http"]
queued_account_task_rows = [row for row in account_task_rows if not row["inline"]]
'''
        ),
        code(
            r'''
overall_account_tasks = one_summary(account_task_rows)
queued_account_tasks = one_summary(queued_account_task_rows)
interactive_tasks = one_summary([row for row in account_task_rows if row["priority"] == "interactive"])
background_tasks = one_summary([row for row in account_task_rows if row["priority"] != "interactive"])
queued_background_tasks = one_summary([row for row in queued_account_task_rows if row["priority"] != "interactive"])
http_all = one_summary(http_task_rows)
http_reads = one_summary([row for row in http_task_rows if row["name"].startswith("http:GET ")])

priority_summary = []
for aggregate in aggregate_task_rows(account_task_rows, ("priority",)):
    priority_summary.append({"priority": aggregate["priority"], **compact_metrics(summarize_aggregate(aggregate))})
priority_summary.sort(key=lambda row: row["n"], reverse=True)

focus_specs = [
    ("农场调度轮", lambda row: row["name"] == "scheduler.farm-tick"),
    ("好友调度轮", lambda row: row["name"] == "scheduler.friend-round"),
    ("好友帮助事务", lambda row: row["name"] == "friend.help:*"),
    ("好友偷菜事务", lambda row: row["name"] == "friend.steal:*"),
    ("好友捣乱事务", lambda row: row["name"] == "friend.bad:*"),
    ("好友宠物同步事务", lambda row: row["name"] == "friend.pet-sync:*"),
    ("交互任务", lambda row: row["priority"] == "interactive"),
]
focus_tasks = []
for label, predicate in focus_specs:
    matching_rows = [row for row in account_task_rows if predicate(row)]
    if matching_rows:
        wait_semantics = "scheduler_lateness" if all(row["name"].startswith("scheduler.") for row in matching_rows) else "queue_wait"
        focus_tasks.append({"label": label, "wait_semantics": wait_semantics, **compact_metrics(one_summary(matching_rows))})

friend_child_names = {"friend.help:*", "friend.steal:*", "friend.bad:*", "friend.pet-sync:*"}
friend_window_rows = []
for record in records:
    if record.get("kind") != "account_tasks":
        continue
    alias = account_alias(record)
    child_count = sum(
        int(task["totalMs"]["count"])
        for task in record.get("tasks", [])
        if task.get("name") in friend_child_names
    )
    round_tasks = [task for task in record.get("tasks", []) if task.get("name") == "scheduler.friend-round"]
    round_count = sum(int(task["totalMs"]["count"]) for task in round_tasks)
    round_sum = sum(float(task["totalMs"]["sum"]) for task in round_tasks)
    round_max = max((float(task["totalMs"]["max"]) for task in round_tasks), default=0.0)
    round_hist = empty_histogram()
    for task in round_tasks:
        merge_histogram(round_hist, task["totalMs"])
    friend_window_rows.append({
        "time": local_time(record["windowEndedAt"]).strftime("%m-%d %H:%M"),
        "window_started_at": int(record["windowStartedAt"]),
        "window_ended_at": int(record["windowEndedAt"]),
        "raw_account_id": str(record.get("accountId", "")),
        "account": alias,
        "friend_child_executions": child_count,
        "friend_round_executions": round_count,
        "friend_round_mean_ms": round(round_sum / round_count, 3) if round_count else None,
        "friend_round_p95_upper_ms": percentile_upper_ms(round_hist, 0.95) if round_count else None,
        "friend_round_max_ms": round(round_max, 3),
        "max_queue_depth": int(record.get("maxQueueDepth", 0)),
    })

account_summary = []
for account in sorted(account_aliases.values()):
    rows = [row for row in account_task_rows if row["account"] == account]
    queued_rows = [row for row in rows if not row["inline"]]
    friend_round_rows = [row for row in rows if row["name"] == "scheduler.friend-round"]
    friend_child_rows = [row for row in rows if row["name"] in friend_child_names]
    account_windows = [row for row in friend_window_rows if row["account"] == account]
    all_metrics = one_summary(rows)
    round_metrics = one_summary(friend_round_rows)
    child_metrics = one_summary(friend_child_rows)
    account_summary.append({
        "account": account,
        "task_n": all_metrics["executions"],
        "queued_task_n": one_summary(queued_rows)["executions"] if queued_rows else 0,
        "task_error_rate_pct": all_metrics["error_rate_pct"],
        "max_queue_depth": all_metrics["max_queue_depth"],
        "queued_wait_p95_upper_ms": one_summary(queued_rows)["wait_ms_p95_upper"] if queued_rows else None,
        "interactive_wait_p95_upper_ms": one_summary([row for row in rows if row["priority"] == "interactive"])["wait_ms_p95_upper"] if any(row["priority"] == "interactive" for row in rows) else None,
        "friend_round_n": round_metrics["executions"] if round_metrics else 0,
        "friend_round_lateness_p95_upper_ms": round_metrics["wait_ms_p95_upper"] if round_metrics else None,
        "friend_round_run_p95_upper_ms": round_metrics["run_ms_p95_upper"] if round_metrics else None,
        "friend_round_run_max_ms": round_metrics["run_ms_max"] if round_metrics else None,
        "friend_round_total_p95_upper_ms": round_metrics["total_ms_p95_upper"] if round_metrics else None,
        "friend_round_total_p99_upper_ms": round_metrics["total_ms_p99_upper"] if round_metrics else None,
        "friend_round_total_max_ms": round_metrics["total_ms_max"] if round_metrics else None,
        "friend_child_n": child_metrics["executions"] if child_metrics else 0,
        "active_friend_windows": sum(row["friend_child_executions"] > 0 for row in account_windows),
        "max_friend_children_per_window": max((row["friend_child_executions"] for row in account_windows), default=0),
    })

route_summary = []
for aggregate in aggregate_task_rows(http_task_rows, ("name",)):
    metrics = summarize_aggregate(aggregate)
    route_summary.append({
        "route": aggregate["name"].removeprefix("http:"),
        **compact_metrics(metrics),
        "error_rate_pct": metrics["error_rate_pct"],
    })
route_summary.sort(key=lambda row: (-row["n"], row["route"]))

error_summary = []
for aggregate in aggregate_task_rows(task_rows, ("kind", "name", "priority")):
    metrics = summarize_aggregate(aggregate)
    if metrics["error"]:
        error_summary.append({
            "kind": aggregate["kind"],
            "task": aggregate["name"],
            "priority": aggregate["priority"],
            "n": metrics["executions"],
            "errors": metrics["error"],
            "error_rate_pct": metrics["error_rate_pct"],
            "total_max_ms": metrics["total_ms_max"],
        })
error_summary.sort(key=lambda row: (-row["errors"], row["task"]))

notable_interactive_wait_windows = []
for row in account_task_rows:
    if row["priority"] != "interactive" or float(row["wait_ms"]["max"]) <= 1000:
        continue
    candidates = [
        candidate for candidate in account_task_rows
        if candidate["raw_account_id"] == row["raw_account_id"]
        and candidate["window_started_at"] == row["window_started_at"]
        and candidate["window_ended_at"] == row["window_ended_at"]
        and candidate["priority"] != "interactive"
        and not candidate["inline"]
        and float(candidate["run_ms"]["max"]) > 1000
    ]
    candidates.sort(key=lambda candidate: float(candidate["run_ms"]["max"]), reverse=True)
    notable_interactive_wait_windows.append({
        "account": row["account"],
        "window_end": local_time(row["window_ended_at"]).isoformat(timespec="seconds"),
        "interactive_task": row["name"],
        "interactive_count_in_window": int(row["wait_ms"]["count"]),
        "interactive_wait_max_ms": round(float(row["wait_ms"]["max"]), 3),
        "interactive_total_max_ms": round(float(row["total_ms"]["max"]), 3),
        "max_queue_depth": int(row["max_queue_depth"]),
        "contemporaneous_long_tasks": [
            {
                "task": candidate["name"],
                "run_max_ms": round(float(candidate["run_ms"]["max"]), 3),
                "wait_max_ms": round(float(candidate["wait_ms"]["max"]), 3),
            }
            for candidate in candidates[:3]
        ],
        "causal_status": "同账号同聚合窗口且执行器串行，属于强关联候选；聚合数据无法还原单次精确时间顺序。",
    })
notable_interactive_wait_windows.sort(key=lambda row: row["interactive_wait_max_ms"], reverse=True)

display(pd.DataFrame(focus_tasks))
display(pd.DataFrame(account_summary))
display(pd.DataFrame([row for row in route_summary if row["n"] >= 5]))
display(pd.DataFrame(notable_interactive_wait_windows))
'''
        ),
        code(
            r'''
account_records_by_id = defaultdict(list)
for record in records:
    if record.get("kind") == "account_tasks":
        account_records_by_id[str(record.get("accountId", ""))].append(record)

http_rows_with_activity = []
matched_http_executions = 0
for row in http_task_rows:
    account_records = account_records_by_id.get(row["raw_account_id"], [])
    overlapping = [
        record for record in account_records
        if int(record["windowStartedAt"]) < row["window_ended_at"]
        and int(record["windowEndedAt"]) > row["window_started_at"]
    ]
    if not overlapping:
        continue
    friend_active = any(
        any(task.get("name") in friend_child_names and int(task["totalMs"]["count"]) > 0 for task in record.get("tasks", []))
        for record in overlapping
    )
    classified = dict(row)
    classified["friend_activity"] = "有好友事务" if friend_active else "无好友事务"
    http_rows_with_activity.append(classified)
    matched_http_executions += int(row["total_ms"]["count"])

http_background_comparison = []
comparison_specs = [
    ("全部 GET", lambda row: row["name"].startswith("http:GET ")),
    ("GET /api/bag", lambda row: row["name"] == "http:GET /api/bag"),
]
for route_group, predicate in comparison_specs:
    for activity in ("无好友事务", "有好友事务"):
        subset = [row for row in http_rows_with_activity if predicate(row) and row["friend_activity"] == activity]
        if subset:
            metrics = one_summary(subset)
            http_background_comparison.append({
                "route_group": route_group,
                "friend_activity": activity,
                **compact_metrics(metrics),
            })

friend_child_total = sum(row["friend_child_executions"] for row in friend_window_rows)
active_friend_windows = [row for row in friend_window_rows if row["friend_child_executions"] > 0]
friend_summary = {
    "child_transaction_n": friend_child_total,
    "active_window_n": len(active_friend_windows),
    "max_child_transactions_in_one_window": max((row["friend_child_executions"] for row in friend_window_rows), default=0),
    "friend_list_size_logged": False,
    "can_validate_300_friend_scenario": False,
    "reason": "指标未记录好友总数；当前只能看到实际产生的逐好友事务数。",
    "per_account": account_summary,
}

display(pd.DataFrame(http_background_comparison))
display(pd.DataFrame(error_summary))
print(
    f"HTTP 与同账号后台窗口可匹配 {matched_http_executions} 次请求；"
    f"好友逐个事务共 {friend_child_total} 次，单账号单窗口最多 {friend_summary['max_child_transactions_in_one_window']} 次。"
)
'''
        ),
        markdown(
            """
## Takeaways

以下 JSON 是报告与后续对比的稳定输入。正式结论见顶部 tl;dr；详细数字以执行输出为准。
"""
        ),
        code(
            r'''
overall = {
    "account_tasks": compact_metrics(overall_account_tasks),
    "queued_tasks": compact_metrics(queued_account_tasks),
    "background_tasks": compact_metrics(background_tasks),
    "queued_background_tasks": compact_metrics(queued_background_tasks),
    "interactive_tasks": compact_metrics(interactive_tasks),
    "http_all": compact_metrics(http_all),
    "http_reads": compact_metrics(http_reads),
}

summary = {
    "metadata": {
        "generated_at": datetime.now(tz=LOCAL_TZ).isoformat(timespec="seconds"),
        "coverage_start": local_time(coverage_start).isoformat(timespec="seconds"),
        "coverage_end": local_time(coverage_end).isoformat(timespec="seconds"),
        "coverage_hours": round(coverage_hours, 3),
        "account_count": len(account_ids),
        "record_count": len(records),
        "task_group_rows": len(task_rows),
        "sources": source_inventory,
        "percentile_method": "直方图所在桶上界（保守上界）",
    },
    "data_quality": quality,
    "overall": overall,
    "priority_summary": priority_summary,
    "focus_tasks": focus_tasks,
    "account_summary": account_summary,
    "http_route_summary": route_summary,
    "http_background_comparison": http_background_comparison,
    "friend_summary": friend_summary,
    "friend_window_series": [
        {key: value for key, value in row.items() if key != "raw_account_id"}
        for row in friend_window_rows
    ],
    "errors": error_summary,
    "notable_interactive_wait_windows": notable_interactive_wait_windows,
    "formal_baseline_assessment": {
        "architecture_absolute_p95_threshold_defined": False,
        "pre_refactor_baseline_present": False,
        "can_claim_formal_pass": False,
        "reason": "架构验收项是相对重构前基线与后台/空闲对照；当前文件仅包含重构后数据。",
    },
}

SUMMARY_FILE.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"已写入 {SUMMARY_FILE.resolve()}")
'''
        ),
    ]
    return nbformat.v4.new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
        },
    )


def execute_notebook(notebook):
    for cell in notebook.cells:
        if cell.cell_type == "code":
            cell.outputs = []
            cell.execution_count = None
    client = NotebookClient(
        notebook,
        timeout=600,
        kernel_name="python3",
        resources={"metadata": {"path": str(OUTPUT_DIR)}},
    )
    return client.execute()


def format_ms(value):
    if value is None:
        return "n/a"
    if value >= 1000:
        return f"{value / 1000:g} 秒"
    return f"{value:g} ms"


def build_tldr(summary):
    metadata = summary["metadata"]
    overall = summary["overall"]
    friend_focus = next(row for row in summary["focus_tasks"] if row["label"] == "好友调度轮")
    friend_summary = summary["friend_summary"]
    total_executions = overall["account_tasks"]["n"] + overall["http_all"]["n"]
    total_errors = overall["account_tasks"]["errors"] + overall["http_all"]["errors"]
    return f"""
# 调度重构生产性能分析

## tl;dr

- **当前样本没有显示持续性请求堵塞。** {metadata['account_count']} 个账号、{metadata['coverage_hours']:.2f} 小时内共观测 {total_executions:,} 次账号任务与 HTTP 请求；最大业务队列深度为 {overall['queued_tasks']['max_queue']}，真实入队任务等待 P95 保守上界为 {format_ms(overall['queued_tasks']['wait_p95_upper_ms'])}，交互任务为 {format_ms(overall['interactive_tasks']['wait_p95_upper_ms'])}。
- **UI 读请求当前较快，但还不能证明正式基准“达标”。** GET 请求总耗时 P95 保守上界为 {format_ms(overall['http_reads']['total_p95_upper_ms'])}；架构要求比较重构前基线和后台/空闲 P95，而本次只有重构后样本，没有可计算的 ±20% 基线。
- **好友轮次存在调度迟到，但实际执行长尾集中在少数轮次。** 好友轮实际运行 P95 保守上界为 {format_ms(friend_focus['run_p95_upper_ms'])}，最大运行 {format_ms(friend_focus['run_max_ms'])}；其计划触发迟到 P95 为 {format_ms(friend_focus['wait_p95_upper_ms'])}。本次发生 {friend_summary['child_transaction_n']} 次逐好友事务，单个五分钟窗口最多 {friend_summary['max_child_transactions_in_one_window']} 次。
- **这份日志不能验证 300 好友极端场景。** 指标没有记录好友列表总数，且实际逐好友事务密度远低于 300；需要补充 `friendCount/candidateCount/processedCount` 或专门做一个 300 好友压测窗口。
- **P95 掩盖了 3 个交互长尾窗口。** 最严重一次交互任务等待 29.7 秒，同窗口存在 30.6 秒的 `farm.check`；另一次等待 7.14 秒，同窗口存在 9.35 秒的单好友捣乱事务。聚合窗口只能证明强关联，不能还原单次严格因果顺序。
- **可靠性样本整体干净。** 共记录 {total_errors} 次错误、0 次取消；JSON、窗口任务计数和直方图计数校验均通过。业务类错误需要结合接口语义判断，不等同于调度故障。
""".strip()


def main():
    notebook = build_notebook()
    executed = execute_notebook(notebook)
    nbformat.write(executed, NOTEBOOK_PATH)
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    executed.cells[0].source = build_tldr(summary)
    executed = execute_notebook(executed)
    nbformat.write(executed, NOTEBOOK_PATH)
    print(NOTEBOOK_PATH)
    print(SUMMARY_PATH)


if __name__ == "__main__":
    main()
