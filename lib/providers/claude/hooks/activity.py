#!/usr/bin/env python3
"""Claude hook for fine-grained task activity and dynamic workflow state."""

import datetime
import json
import os
import re
import sqlite3
import sys

TAIL_BYTES = 2 * 1024 * 1024
MIN_DELAY = 60
MAX_DELAY = 3600
GRACE_SECONDS = 120
WORKFLOW_CAP_SECONDS = 30 * 60

TERMINAL_STATUS_RE = re.compile(
    r"<status>\s*(completed|failed|error|errored|cancelled|canceled|killed|done)\s*</status>",
    re.IGNORECASE,
)


def resolve_db_path():
    return os.environ.get("CC_DB_PATH")


def parse_tail(path):
    if not path:
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()
            raw = f.read()
    except OSError:
        return []
    out = []
    for line in raw.decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def _messages(entries):
    for obj in entries:
        if not isinstance(obj, dict) or obj.get("type") not in ("user", "assistant"):
            continue
        msg = obj.get("message")
        if isinstance(msg, dict):
            yield (msg.get("role") or obj.get("type"), msg.get("content"))


def _tool_uses(content):
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            yield block


def _texts(content):
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                yield block
            elif isinstance(block, dict) and block.get("type") == "text":
                yield block.get("text") or ""


def _is_real_user_prompt(content):
    for text in _texts(content):
        if text.strip() and "<task-notification>" not in text:
            return True
    return False


def _clamp_delay(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return MAX_DELAY
    return max(MIN_DELAY, min(MAX_DELAY, parsed))


def detect_pending(entries, now):
    msgs = list(_messages(entries))

    boundary = -1
    for idx, (role, content) in enumerate(msgs):
        if role == "user" and _is_real_user_prompt(content):
            boundary = idx

    loop_delay = None
    for role, content in msgs[boundary + 1:]:
        if role != "assistant":
            continue
        for block in _tool_uses(content):
            if block.get("name") == "ScheduleWakeup":
                loop_delay = _clamp_delay((block.get("input") or {}).get("delaySeconds"))
    loop_wake = now + datetime.timedelta(seconds=loop_delay + GRACE_SECONDS) if loop_delay is not None else None

    launches = 0
    completions = 0
    for role, content in msgs:
        if role == "assistant":
            for block in _tool_uses(content):
                if block.get("name") == "Workflow":
                    launches += 1
        for text in _texts(content):
            if "<task-notification>" in text and TERMINAL_STATUS_RE.search(text):
                completions += 1
    workflow_wake = now + datetime.timedelta(seconds=WORKFLOW_CAP_SECONDS) if launches > completions else None

    return {"loop": loop_wake, "workflow": workflow_wake}


def resolve_stop_state(data, now):
    signals = detect_pending(parse_tail(data.get("transcript_path")), now)
    loop_wake = signals["loop"]
    workflow_wake = signals["workflow"]

    crons = data.get("session_crons")
    if isinstance(crons, (list, dict)):
        if len(crons) > 0 and loop_wake is None:
            loop_wake = now + datetime.timedelta(seconds=MAX_DELAY + GRACE_SECONDS)
        elif len(crons) == 0:
            loop_wake = None

    candidates = [wake for wake in (loop_wake, workflow_wake) if wake is not None]
    if candidates:
        return "workflow", max(candidates).isoformat()
    return "idle", None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        data = {}

    task_id = os.environ.get("CC_TASK_ID")
    db_path = resolve_db_path()
    if not task_id or not db_path or not os.path.exists(db_path):
        return 0

    event = data.get("hook_event_name") or ""
    now = datetime.datetime.now(datetime.timezone.utc)
    if event == "UserPromptSubmit":
        activity, wake_at = "working", None
    elif event == "Stop":
        activity, wake_at = resolve_stop_state(data, now)
    else:
        activity, wake_at = "idle", None

    conn = sqlite3.connect(db_path, timeout=5)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute(
            "UPDATE tasks SET activity=?, wake_at=?, updated_at=? WHERE id=? AND archived=0",
            (activity, wake_at, now.isoformat(), task_id),
        )
        conn.commit()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception as exc:
        sys.stderr.write("activity hook error: %s\n" % exc)
        sys.exit(0)
