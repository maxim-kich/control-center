#!/usr/bin/env python3
"""Claude SessionEnd hook: stamp session end without marking the task done."""

import datetime
import json
import os
import sqlite3
import sys


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        data = {}

    session_id = data.get("session_id")
    task_id = os.environ.get("CC_TASK_ID")
    db_path = os.environ.get("CC_DB_PATH")
    if not db_path or not os.path.exists(db_path):
        return 0

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        if session_id:
            conn.execute(
                "UPDATE sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
                (now, session_id),
            )
        if task_id:
            conn.execute(
                "UPDATE tasks SET activity=NULL, wake_at=NULL, updated_at=? WHERE id=?",
                (now, task_id),
            )
        elif session_id:
            conn.execute(
                "UPDATE tasks SET activity=NULL, wake_at=NULL, updated_at=? WHERE session_id=?",
                (now, session_id),
            )
        conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as exc:
        sys.stderr.write("on_stop hook error: %s\n" % exc)
        sys.exit(0)
