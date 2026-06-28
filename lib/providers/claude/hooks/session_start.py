#!/usr/bin/env python3
"""Claude SessionStart hook: capture the session id for a Control Center task."""

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
    transcript_path = data.get("transcript_path")
    cwd = data.get("cwd")
    source = data.get("source")
    task_id = os.environ.get("CC_TASK_ID")
    kind = os.environ.get("CC_SESSION_KIND")
    db_path = os.environ.get("CC_DB_PATH")
    if not session_id or not db_path or not os.path.exists(db_path):
        return 0

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute(
            """
            INSERT INTO sessions (session_id, provider, task_id, kind, transcript_path, cwd, source, started_at)
            VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              provider        = 'claude',
              task_id         = COALESCE(excluded.task_id, sessions.task_id),
              kind            = COALESCE(excluded.kind, sessions.kind),
              transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
              cwd             = COALESCE(excluded.cwd, sessions.cwd),
              source          = excluded.source,
              ended_at        = NULL
            """,
            (session_id, task_id, kind, transcript_path, cwd, source, now),
        )
        if task_id:
            has_prompt = os.environ.get("CC_HAS_PROMPT")
            activity = "working" if kind == "start" and has_prompt else "idle"
            row = conn.execute("SELECT session_id, status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            current = row[0] if row else None
            prev_status = row[1] if row else None
            adopt = source in (None, "startup", "resume")
            if adopt and current and current != session_id:
                still_live = conn.execute(
                    "SELECT 1 FROM sessions WHERE session_id = ? AND ended_at IS NULL",
                    (current,),
                ).fetchone()
                if still_live:
                    adopt = False
            column_changed_at = now if prev_status != "in_progress" else None
            if adopt or not current:
                conn.execute(
                    """
                    UPDATE tasks
                    SET session_id=?, status='in_progress', activity=?, wake_at=NULL,
                        started_at=COALESCE(started_at, ?), ended_at=NULL,
                        column_changed_at=COALESCE(?, column_changed_at),
                        updated_at=?
                    WHERE id=?
                    """,
                    (session_id, activity, now, column_changed_at, now, task_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE tasks
                    SET status='in_progress', activity=?, wake_at=NULL, ended_at=NULL,
                        column_changed_at=COALESCE(?, column_changed_at),
                        updated_at=?
                    WHERE id=?
                    """,
                    (activity, column_changed_at, now, task_id),
                )
        conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as exc:
        sys.stderr.write("session_start hook error: %s\n" % exc)
        sys.exit(0)
