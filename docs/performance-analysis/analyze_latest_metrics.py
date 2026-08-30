from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean


ANALYSIS_DIR = Path(__file__).resolve().parent
DOCS_DIR = ANALYSIS_DIR.parent
INPUT_PATHS = (
    DOCS_DIR / "task-metrics-2026-08-28.jsonl",
    DOCS_DIR / "task-metrics-2026-08-29.jsonl",
)
BASELINE_PATH = ANALYSIS_DIR / "analysis-summary.json"
OUTPUT_PATH = ANALYSIS_DIR / "latest-analysis-summary.json"
LOCAL_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


def load_jsonl(path: Path) -> tuple[list[dict], list[dict]]:
    records: list[dict] = []
    errors: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                errors.append(
                    {
                        "file": path.relative_to(path.parents[1]).as_posix(),
                        "line": line_number,
                        "error": str(error),
                    }
                )
    return records, errors


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def local_iso(epoch_ms: int | float) -> str:
    return datetime.fromtimestamp(float(epoch_ms) / 1000, tz=LOCAL_TZ).isoformat(timespec="seconds")


def empty_histogram(bounds: list[float]) -> dict:
    return {"count": 0, "sum": 0.0, "max": 0.0, "buckets": [0] * (len(bounds) + 1)}


def merge_histogram(target: dict, source: dict) -> None:
    target["count"] += int(source.get("count", 0))
    target["sum"] += float(source.get("sum", 0))
    target["max"] = max(float(target["max"]), float(source.get("max", 0)))
    buckets = source.get("buckets", [])
    for index, value in enumerate(buckets[: len(target["buckets"])]):
        target["buckets"][index] += int(value)


def percentile_upper(histogram: dict, bounds: list[float], percentile: float) -> float | None:
    count = int(histogram["count"])
    if count == 0:
        return None
    target = max(1, math.ceil(count * percentile))
    cumulative = 0
    for index, value in enumerate(histogram["buckets"]):
        cumulative += int(value)
        if cumulative >= target:
            if index < len(bounds):
                return float(bounds[index])
            return float(histogram["max"])
    return float(histogram["max"])


def count_over(histogram: dict, bounds: list[float], threshold: float) -> int:
    try:
        threshold_index = bounds.index(threshold)
    except ValueError:
        return 0
    return sum(int(value) for value in histogram["buckets"][threshold_index + 1 :])


def flatten_tasks(records: list[dict], aliases: dict[str, str]) -> list[dict]:
    rows: list[dict] = []
    for record in records:
        for task in record.get("tasks", []):
            rows.append(
                {
                    "kind": record.get("kind"),
                    "account": aliases.get(str(record.get("accountId")), "unscoped"),
                    "account_id": str(record.get("accountId")),
                    "window_started_at": int(record["windowStartedAt"]),
                    "window_ended_at": int(record["windowEndedAt"]),
                    **task,
                }
            )
    return rows


def summarize_tasks(rows: list[dict], bounds: list[float]) -> dict:
    waits = empty_histogram(bounds)
    runs = empty_histogram(bounds)
    totals = empty_histogram(bounds)
    outcomes = Counter()
    max_queue = 0
    dedupe_hits = 0
    for row in rows:
        merge_histogram(waits, row["waitMs"])
        merge_histogram(runs, row["runMs"])
        merge_histogram(totals, row["totalMs"])
        outcomes.update(row.get("outcomes", {}))
        max_queue = max(max_queue, int(row.get("maxQueueDepth", 0)))
        dedupe_hits += int(row.get("dedupeHits", 0))

    def latency(histogram: dict) -> dict:
        count = int(histogram["count"])
        return {
            "mean_ms": round(float(histogram["sum"]) / count, 3) if count else None,
            "p50_upper_ms": percentile_upper(histogram, bounds, 0.50),
            "p95_upper_ms": percentile_upper(histogram, bounds, 0.95),
            "p99_upper_ms": percentile_upper(histogram, bounds, 0.99),
            "max_ms": round(float(histogram["max"]), 3) if count else None,
            "over_1s_n": count_over(histogram, bounds, 1000),
            "over_5s_n": count_over(histogram, bounds, 5000),
        }

    executions = int(totals["count"])
    partial = int(outcomes["partial"])
    errors = int(outcomes["error"])
    cancelled = int(outcomes["cancelled"])
    return {
        "n": executions,
        "success": int(outcomes["success"]),
        "partial": partial,
        "errors": errors,
        "cancelled": cancelled,
        "error_rate": round(errors / executions, 8) if executions else None,
        "partial_rate": round(partial / executions, 8) if executions else None,
        "max_queue_depth": max_queue,
        "dedupe_hits": dedupe_hits,
        "wait": latency(waits),
        "run": latency(runs),
        "total": latency(totals),
    }


def group_task_summary(rows: list[dict], bounds: list[float], fields: tuple[str, ...]) -> list[dict]:
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[tuple(row.get(field) for field in fields)].append(row)
    output: list[dict] = []
    for key, group in grouped.items():
        output.append({**dict(zip(fields, key)), **summarize_tasks(group, bounds)})
    return output


def nearest_rank(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    return ordered[max(0, math.ceil(len(ordered) * percentile) - 1)]


def exact_latency(values: list[float]) -> dict:
    if not values:
        return {"mean_ms": None, "p50_ms": None, "p95_ms": None, "p99_ms": None, "max_ms": None}
    return {
        "mean_ms": round(mean(values), 3),
        "p50_ms": round(float(nearest_rank(values, 0.50)), 3),
        "p95_ms": round(float(nearest_rank(values, 0.95)), 3),
        "p99_ms": round(float(nearest_rank(values, 0.99)), 3),
        "max_ms": round(max(values), 3),
    }


def friend_round_summary(records: list[dict], aliases: dict[str, str]) -> dict:
    rounds: list[dict] = []
    reported_count = 0
    for record in records:
        reported_count += int(record.get("friendRoundCount", 0))
        for item in record.get("friendRounds", []):
            rounds.append(
                {
                    **item,
                    "account": aliases[str(record["accountId"])],
                    "window_started_at": int(record["windowStartedAt"]),
                }
            )

    def summarize(group: list[dict], account: str) -> dict:
        group = sorted(group, key=lambda row: int(row["startedAt"]))
        starts = [int(row["startedAt"]) for row in group]
        gaps = [starts[index] - starts[index - 1] for index in range(1, len(starts))]
        friend_counts = [int(row.get("friendCount", 0)) for row in group]
        candidate_types = Counter()
        processed_types = Counter()
        friend_list_sources = Counter()
        for row in group:
            candidate_types.update(row.get("candidates", {}))
            processed_types.update(row.get("processed", {}))
            source = str(row.get("friendListSource") or "unknown")
            friend_list_sources.update([source if source in {"cache", "singleflight", "network"} else "unknown"])
        candidate_count = sum(int(row.get("candidateCount", 0)) for row in group)
        processed_count = sum(int(row.get("processedCount", 0)) for row in group)
        deferred_count = sum(int(row.get("deferredCount", 0)) for row in group)
        longest = max(group, key=lambda row: int(row.get("durationMs", 0))) if group else None
        return {
            "account": account,
            "round_samples": len(group),
            "start": local_iso(starts[0]) if starts else None,
            "end": local_iso(int(group[-1]["finishedAt"])) if group else None,
            "duration": exact_latency([int(row.get("durationMs", 0)) for row in group]),
            "start_gap": exact_latency(gaps),
            "friend_count": {
                "min": min(friend_counts) if friend_counts else None,
                "p50": nearest_rank(friend_counts, 0.50),
                "p95": nearest_rank(friend_counts, 0.95),
                "max": max(friend_counts) if friend_counts else None,
                "distinct": sorted(set(friend_counts)),
            },
            "candidate_count": candidate_count,
            "processed_count": processed_count,
            "deferred_count": deferred_count,
            "processed_share": round(processed_count / candidate_count, 8) if candidate_count else None,
            "rounds_with_candidates": sum(int(row.get("candidateCount", 0)) > 0 for row in group),
            "rounds_with_deferred": sum(int(row.get("deferredCount", 0)) > 0 for row in group),
            "errors": sum(row.get("outcome") == "error" for row in group),
            "cancelled": sum(row.get("outcome") == "cancelled" for row in group),
            "friend_list_sources": {
                key: int(friend_list_sources[key])
                for key in ("network", "cache", "singleflight", "unknown")
            },
            "candidates": {key: int(candidate_types[key]) for key in ("steal", "help", "bad")},
            "processed": {key: int(processed_types[key]) for key in ("steal", "help", "bad")},
            "longest_round": (
                {
                    "started_at": local_iso(int(longest["startedAt"])),
                    "duration_ms": int(longest.get("durationMs", 0)),
                    "outcome": longest.get("outcome"),
                    "friend_count": int(longest.get("friendCount", 0)),
                    "candidate_count": int(longest.get("candidateCount", 0)),
                    "processed_count": int(longest.get("processedCount", 0)),
                    "deferred_count": int(longest.get("deferredCount", 0)),
                    "friend_list_source": str(longest.get("friendListSource") or "unknown"),
                }
                if longest
                else None
            ),
        }

    per_account = [
        summarize([row for row in rounds if row["account"] == account], account)
        for account in sorted({row["account"] for row in rounds})
    ]
    overall = summarize(rounds, "ALL")
    overall["reported_round_count"] = reported_count
    overall["sample_truncation_n"] = max(0, reported_count - len(rounds))
    return {"overall": overall, "per_account": per_account}


def friend_list_source_summary(records: list[dict]) -> dict:
    totals = Counter()
    records_with_sources = 0
    for record in records:
        sources = record.get("friendListSources")
        if not isinstance(sources, dict):
            continue
        records_with_sources += 1
        for key in ("network", "cache", "singleflight", "unknown"):
            totals[key] += max(0, int(sources.get(key, 0)))
    return {
        "records_with_sources": records_with_sources,
        "totals": {key: int(totals[key]) for key in ("network", "cache", "singleflight", "unknown")},
    }


def scheduler_interval_summary(records: list[dict], aliases: dict[str, str]) -> dict:
    fields = ("farmMinMs", "farmMaxMs", "friendMinMs", "friendMaxMs")
    rows: list[dict] = []
    for record in records:
        intervals = record.get("schedulerIntervals")
        if record.get("kind") != "account_tasks" or not isinstance(intervals, dict):
            continue
        values = {field: round(float(intervals.get(field, 0)), 3) for field in fields}
        rows.append(
            {
                "account": aliases[str(record["accountId"])],
                "window_ended_at": int(record["windowEndedAt"]),
                **values,
            }
        )

    per_account = []
    for account in sorted({row["account"] for row in rows}):
        group = [row for row in rows if row["account"] == account]
        latest = max(group, key=lambda row: row["window_ended_at"])
        distinct = sorted({tuple(row[field] for field in fields) for row in group})
        per_account.append(
            {
                "account": account,
                "record_count": len(group),
                "latest": {field: latest[field] for field in fields},
                "distinct": [dict(zip(fields, values)) for values in distinct],
            }
        )
    return {"record_count": len(rows), "per_account": per_account}


def slow_task_summary(records: list[dict], aliases: dict[str, str]) -> dict:
    samples: list[dict] = []
    for record in records:
        for item in record.get("slowTasks", []):
            samples.append(
                {
                    "account": aliases[str(record["accountId"])],
                    "window_end": local_iso(int(record["windowEndedAt"])),
                    "finished_at": local_iso(int(item["finishedAt"])),
                    "name": item.get("name"),
                    "priority": item.get("priority"),
                    "outcome": item.get("outcome"),
                    "inline": bool(item.get("inline")),
                    "task_id": item.get("taskId"),
                    "request_id": item.get("requestId"),
                    "parent_task_id": item.get("parentTaskId"),
                    "parent_task_name": item.get("parentTaskName"),
                    "blocked_by_task_id": item.get("blockedByTaskId"),
                    "blocked_by_task_name": item.get("blockedByTaskName"),
                    "wait_ms": round(float(item.get("waitMs", 0)), 3),
                    "run_ms": round(float(item.get("runMs", 0)), 3),
                    "total_ms": round(float(item.get("totalMs", 0)), 3),
                    "queue_depth_at_submit": int(item.get("queueDepthAtSubmit", 0)),
                }
            )
    samples.sort(key=lambda row: row["total_ms"], reverse=True)
    by_name = Counter(row["name"] for row in samples)
    return {
        "sample_count": len(samples),
        "interactive_sample_count": sum(row["priority"] == "interactive" for row in samples),
        "request_linked_sample_count": sum(bool(row["request_id"]) for row in samples),
        "parent_linked_sample_count": sum(bool(row["parent_task_id"]) for row in samples),
        "blocker_linked_sample_count": sum(bool(row["blocked_by_task_id"]) for row in samples),
        "by_name": [{"name": name, "samples": count} for name, count in by_name.most_common()],
        "samples": samples,
    }


def source_metadata(path: Path) -> dict:
    return {"file": path.relative_to(path.parents[1]).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)}


def combined_source_metadata(paths: tuple[Path, ...]) -> dict:
    digest = hashlib.sha256()
    sources = []
    for path in paths:
        sources.append(source_metadata(path))
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return {
        "files": sources,
        "bytes": sum(source["bytes"] for source in sources),
        "sha256": digest.hexdigest(),
    }


def build_summary() -> dict:
    records: list[dict] = []
    parse_errors: list[dict] = []
    for path in INPUT_PATHS:
        current_records, current_errors = load_jsonl(path)
        records.extend(current_records)
        parse_errors.extend(current_errors)
    if not records:
        raise RuntimeError(f"没有可分析记录: {', '.join(str(path) for path in INPUT_PATHS)}")

    bucket_sets = {tuple(record.get("latencyBucketBoundsMs", [])) for record in records}
    if len(bucket_sets) != 1:
        raise RuntimeError(f"延迟桶边界不一致: {sorted(bucket_sets)}")
    bounds = [float(value) for value in next(iter(bucket_sets))]

    account_ids = sorted(
        {str(record["accountId"]) for record in records if record.get("kind") == "account_tasks"},
        key=lambda value: int(value) if value.isdigit() else value,
    )
    aliases = {account_id: f"A{index:02d}" for index, account_id in enumerate(account_ids, start=1)}
    aliases["unscoped"] = "unscoped"

    latest_record = max(records, key=lambda record: int(record["windowEndedAt"]))
    target_build_sha = latest_record.get("buildSha")
    if not target_build_sha:
        raise RuntimeError("最新记录缺少 buildSha，无法隔离本次部署样本")
    post_records = [record for record in records if record.get("buildSha") == target_build_sha]
    if not post_records:
        raise RuntimeError(f"没有找到目标部署记录: {target_build_sha}")
    instrumentation_start = min(int(record["windowStartedAt"]) for record in post_records)
    pre_records = [record for record in records if int(record["windowEndedAt"]) <= instrumentation_start]
    overlap_records = [
        record
        for record in records
        if record.get("buildSha") != target_build_sha
        and int(record["windowStartedAt"]) < instrumentation_start < int(record["windowEndedAt"])
    ]

    duplicate_keys = Counter(
        (
            record.get("kind"),
            str(record.get("accountId")),
            int(record["windowStartedAt"]),
            int(record["windowEndedAt"]),
        )
        for record in records
    )
    duplicate_rows = sum(count - 1 for count in duplicate_keys.values() if count > 1)

    all_rows = flatten_tasks(records, aliases)
    post_rows = flatten_tasks(post_records, aliases)
    pre_rows = flatten_tasks(pre_records, aliases)

    def metric_set(rows: list[dict]) -> dict:
        queued = [row for row in rows if row["kind"] == "account_tasks" and not row.get("inline")]
        return {
            "account_tasks": summarize_tasks([row for row in rows if row["kind"] == "account_tasks"], bounds),
            "queued_tasks": summarize_tasks(queued, bounds),
            "interactive_queued_tasks": summarize_tasks([row for row in queued if row.get("priority") == "interactive"], bounds),
            "background_queued_tasks": summarize_tasks([row for row in queued if row.get("priority") != "interactive"], bounds),
            "http_all": summarize_tasks([row for row in rows if row["kind"] == "http"], bounds),
            "http_get": summarize_tasks([row for row in rows if row["kind"] == "http" and row["name"].startswith("http:GET ")], bounds),
            "scheduler_farm": summarize_tasks([row for row in rows if row["name"] == "scheduler.farm-tick"], bounds),
            "scheduler_friend": summarize_tasks([row for row in rows if row["name"] == "scheduler.friend-round"], bounds),
        }

    all_metrics = metric_set(all_rows)
    post_metrics = metric_set(post_rows)

    route_rows = [row for row in post_rows if row["kind"] == "http"]
    http_routes = group_task_summary(route_rows, bounds, ("name",))
    for row in http_routes:
        row["route"] = row.pop("name").removeprefix("http:")
    http_routes.sort(key=lambda row: (-row["n"], row["route"]))

    phase_rows = [row for row in post_rows if row["name"].startswith(("farm.phase.", "friend.phase."))]
    phase_summary = group_task_summary(phase_rows, bounds, ("name", "priority"))
    phase_summary.sort(key=lambda row: (-(row["run"]["max_ms"] or 0), -row["n"], row["name"]))

    task_summary = group_task_summary(post_rows, bounds, ("kind", "name", "priority", "inline"))
    task_summary.sort(key=lambda row: (row["kind"], row["name"], row["priority"], row["inline"]))

    account_rows = [row for row in post_rows if row["kind"] == "account_tasks"]
    per_account = []
    for account in sorted(set(row["account"] for row in account_rows)):
        group = [row for row in account_rows if row["account"] == account]
        queued = [row for row in group if not row.get("inline")]
        account_records = [
            record
            for record in post_records
            if record.get("kind") == "account_tasks"
            and aliases[str(record.get("accountId"))] == account
        ]
        observed_ms = (
            max(int(record["windowEndedAt"]) for record in account_records)
            - min(int(record["windowStartedAt"]) for record in account_records)
        )
        farm_summary = summarize_tasks([row for row in group if row["name"] == "scheduler.farm-tick"], bounds)
        friend_summary = summarize_tasks([row for row in group if row["name"] == "scheduler.friend-round"], bounds)
        per_account.append(
            {
                "account": account,
                "observed_hours": round(observed_ms / 3_600_000, 3),
                "account_tasks": summarize_tasks(group, bounds),
                "queued_tasks": summarize_tasks(queued, bounds),
                "interactive_queued_tasks": summarize_tasks(
                    [row for row in queued if row.get("priority") == "interactive"], bounds
                ),
                "scheduler_farm": farm_summary,
                "scheduler_friend": friend_summary,
                "farm_start_gap_mean_approx_ms": round(observed_ms / farm_summary["n"], 3)
                if farm_summary["n"]
                else None,
            }
        )

    read_fresh_names = {
        "http:GET /api/bag",
        "http:GET /api/seeds",
        "http:GET /api/bag/seeds",
        "api:getBag",
        "api:getSeeds",
        "api:getBagSeeds",
    }

    def read_fresh_period(rows: list[dict]) -> list[dict]:
        selected = [row for row in rows if row["name"] in read_fresh_names]
        summary = group_task_summary(selected, bounds, ("kind", "name"))
        summary.sort(key=lambda row: (row["kind"], row["name"]))
        return summary

    friend_rounds = friend_round_summary(post_records, aliases)
    friend_list_sources = friend_list_source_summary(post_records)
    scheduler_intervals = scheduler_interval_summary(post_records, aliases)
    slow_tasks = slow_task_summary(post_records, aliases)

    account_post_records = [record for record in post_records if record.get("kind") == "account_tasks"]
    http_background_rows: list[dict] = []
    for row in [item for item in post_rows if item["kind"] == "http" and item["name"].startswith("http:GET ")]:
        overlapping = [
            record
            for record in account_post_records
            if str(record.get("accountId")) == row["account_id"]
            and int(record["windowStartedAt"]) < row["window_ended_at"]
            and int(record["windowEndedAt"]) > row["window_started_at"]
        ]
        if not overlapping:
            continue
        has_slow_background = any(
            any(sample.get("priority") != "interactive" for sample in record.get("slowTasks", []))
            for record in overlapping
        )
        http_background_rows.append(
            {**row, "background_state": "slow_background" if has_slow_background else "ordinary_background"}
        )

    http_background_comparison: list[dict] = []
    for scope, predicate in (
        ("全部 GET", lambda row: True),
        ("GET /api/bag", lambda row: row["name"] == "http:GET /api/bag"),
    ):
        for state in ("ordinary_background", "slow_background"):
            selected = [
                row
                for row in http_background_rows
                if row["background_state"] == state and predicate(row)
            ]
            http_background_comparison.append(
                {"scope": scope, "background_state": state, **summarize_tasks(selected, bounds)}
            )

    detailed_friend_errors = friend_rounds["overall"]["errors"]
    scheduler_friend_errors = post_metrics["scheduler_friend"]["errors"]
    scheduler_farm_errors = post_metrics["scheduler_farm"]["errors"]
    farm_check_metrics = summarize_tasks(
        [row for row in post_rows if row["name"] == "farm.check"], bounds
    )
    farm_phase_errors = sum(
        row["errors"] for row in phase_summary if row["name"].startswith("farm.phase.")
    )

    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8")) if BASELINE_PATH.exists() else None
    previous = None
    if baseline:
        previous_friend = next(
            (item for item in baseline.get("focus_tasks", []) if item.get("label") == "好友调度轮"),
            None,
        )
        previous = {
            "metadata": baseline.get("metadata"),
            "metrics": {
                "http_get": baseline.get("overall", {}).get("http_reads"),
                "queued_tasks": baseline.get("overall", {}).get("queued_tasks"),
                "interactive_queued_tasks": baseline.get("overall", {}).get("interactive_tasks"),
                "scheduler_friend": previous_friend,
            },
            "reproducible_from_current_files": False,
            "reason": "上一轮 summary 引用了已被本次下载覆盖的同名 2026-08-28 JSONL；保留其哈希快照作历史对照。",
        }

    total_start = min(int(record["windowStartedAt"]) for record in records)
    total_end = max(int(record["windowEndedAt"]) for record in records)
    post_start = min(int(record["windowStartedAt"]) for record in post_records)
    post_end = max(int(record["windowEndedAt"]) for record in post_records)

    return {
        "generated_at": datetime.now(tz=LOCAL_TZ).isoformat(timespec="seconds"),
        "metadata": {
            "source": combined_source_metadata(INPUT_PATHS),
            "coverage_start": local_iso(total_start),
            "coverage_end": local_iso(total_end),
            "coverage_hours": round((total_end - total_start) / 3_600_000, 3),
            "instrumentation_start": local_iso(instrumentation_start),
            "instrumented_coverage_start": local_iso(post_start),
            "instrumented_coverage_end": local_iso(post_end),
            "instrumented_coverage_hours": round((post_end - post_start) / 3_600_000, 3),
            "accounts": sorted(aliases[account_id] for account_id in account_ids),
            "record_count": len(records),
            "post_record_count": len(post_records),
            "target_build_sha": target_build_sha,
            "percentile_method": "聚合直方图 nearest-rank 所在桶上界；好友轮明细使用精确 nearest-rank",
        },
        "data_quality": {
            "parse_errors": parse_errors,
            "duplicate_rows": duplicate_rows,
            "kinds": dict(Counter(str(record.get("kind")) for record in records)),
            "schema_versions": dict(Counter(str(record.get("schemaVersion")) for record in records)),
            "bot_versions": dict(Counter(str(record.get("botVersion")) for record in records)),
            "build_shas": dict(Counter(str(record.get("buildSha") or "(missing)") for record in records)),
            "records_with_friend_rounds": sum("friendRounds" in record for record in records),
            "records_with_friend_list_sources": sum("friendListSources" in record for record in records),
            "records_with_scheduler_intervals": sum("schedulerIntervals" in record for record in records),
            "records_with_slow_tasks": sum("slowTasks" in record for record in records),
            "overlap_record_count": len(overlap_records),
            "version_identifies_deployment": True,
            "version_note": f"优化后样本严格限定为 buildSha={target_build_sha}；botVersion 仅用于版本展示。",
        },
        "latest_metrics": all_metrics,
        "instrumented_metrics": post_metrics,
        "per_account_instrumented": per_account,
        "http_routes": http_routes,
        "task_summary": task_summary,
        "phase_summary": phase_summary,
        "http_background_comparison": http_background_comparison,
        "read_fresh_transition": {
            "pre_instrumentation": read_fresh_period(pre_rows),
            "post_instrumentation": read_fresh_period(post_rows),
        },
        "friend_rounds": friend_rounds,
        "friend_list_sources": friend_list_sources,
        "scheduler_intervals": scheduler_intervals,
        "slow_tasks": slow_tasks,
        "outcome_consistency": {
            "friend_round_detail_errors": detailed_friend_errors,
            "scheduler_friend_errors": scheduler_friend_errors,
            "farm_phase_errors": farm_phase_errors,
            "farm_check_errors": farm_check_metrics["errors"],
            "scheduler_farm_errors": scheduler_farm_errors,
        },
        "previous_report_snapshot": previous,
    }


def main() -> None:
    summary = build_summary()
    OUTPUT_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
