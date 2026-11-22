#!/usr/bin/env python3
"""Merge fields into the panel's update-status.json.

The panel reads this file from its data directory (`/api/update/status`).
Configure the location with UPDATE_STATUS_FILE, or with DATA_DIR (defaults to
the Docker volume of the compose file).

Usage:
  update-status.py --state running --step build
  update-status.py --state success --deployed <sha> --has-update false --commits-file /tmp/c.txt
"""
import argparse
import json
import os
import time

DATA_DIR = os.environ.get("DATA_DIR", "/var/lib/docker/volumes/qq-farm-data/_data")
STATUS = os.environ.get("UPDATE_STATUS_FILE", os.path.join(DATA_DIR, "update-status.json"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state")
    ap.add_argument("--step")
    ap.add_argument("--deployed")
    ap.add_argument("--deployed-short")
    ap.add_argument("--latest")
    ap.add_argument("--latest-short")
    ap.add_argument("--behind", type=int)
    ap.add_argument("--has-update", choices=["true", "false"])
    ap.add_argument("--commits-file")
    ap.add_argument("--message")
    ap.add_argument("--checked-at", type=int)
    args = ap.parse_args()

    try:
        with open(STATUS, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        data = {}

    for key, value in {
        "state": args.state,
        "step": args.step,
        "deployedSha": args.deployed,
        "deployedShort": args.deployed_short,
        "latestSha": args.latest,
        "latestShort": args.latest_short,
        "behind": args.behind,
        "message": args.message,
        "checkedAt": args.checked_at,
    }.items():
        if value is not None:
            data[key] = value

    if args.has_update is not None:
        data["hasUpdate"] = args.has_update == "true"

    if args.commits_file is not None:
        try:
            with open(args.commits_file, encoding="utf-8") as fh:
                data["commits"] = [line.strip() for line in fh if line.strip()]
        except FileNotFoundError:
            data["commits"] = []

    data["updatedAt"] = int(time.time() * 1000)
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATUS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
