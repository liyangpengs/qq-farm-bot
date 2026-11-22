#!/usr/bin/env python3
"""Send a Bark notification using the token configured in the bot's own
offline-reminder settings. Secrets are read from store.json and never printed.

Usage: notify.py <title> <body>
Exit codes: 0 ok, 2 no usable bark config, 3 bark rejected, 4 request failed.
"""
import json
import os
import sys
import urllib.error
import urllib.request

DATA_DIR = os.environ.get("DATA_DIR", "/var/lib/docker/volumes/qq-farm-data/_data")
STORE = os.environ.get("STORE_FILE", os.path.join(DATA_DIR, "store.json"))
NOTIFY_GROUP = os.environ.get("NOTIFY_GROUP", "qq-farm-bot")
BARK_PUSH = "https://api.day.app/push"


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    title, body = sys.argv[1], sys.argv[2]

    try:
        with open(STORE, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return 2

    reminder = cfg.get("offlineReminder") or {}
    channel = str(reminder.get("channel") or "").strip().lower()
    token = str(reminder.get("token") or "").strip()
    if channel != "bark" or not token:
        return 2

    payload = json.dumps({
        "device_key": token,
        "title": title,
        "body": body,
        "group": NOTIFY_GROUP,
    }).encode("utf-8")
    req = urllib.request.Request(
        BARK_PUSH, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, ValueError):
        return 4
    return 0 if int(data.get("code", 0)) == 200 else 3


if __name__ == "__main__":
    sys.exit(main())
