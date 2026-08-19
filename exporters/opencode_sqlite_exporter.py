#!/usr/bin/env python3
"""Emit a source-redacted Control Tower workstream from an OpenCode database.

This exporter is deployed beside a single agent runtime. It reads a root-owned
configuration file, accepts only that configured agent and channel, opens the
OpenCode SQLite database read-only, and prints one bounded JSON document.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = "/etc/control-tower/opencode-exporter.json"
MAX_ACTIVITY = 200
MAX_VISIBLE_TEXT = 1_200
MAX_VISIBLE_RESULT = 4_000
MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024

SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[\"']?[^\s\"'`]+"
)
CREDENTIAL = re.compile(r"\b(?:nsec1|sk-|gh[pousr]_|tskey-)[A-Za-z0-9_-]{8,}\b")
PRIVATE_SIZED_HEX = re.compile(r"\b[0-9a-fA-F]{64}\b")
CHANNEL_ID = re.compile(r"^[0-9a-fA-F-]{36}$")
PUBKEY = re.compile(r"^[0-9a-f]{64}$")
PATCH_PATH = re.compile(r"^(?:\+\+\+|---)\s+(?:[ab]/)?(.+)$", re.MULTILINE)


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def load_json(raw: Any, fallback: Any) -> Any:
    if not isinstance(raw, str):
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def redacted(value: Any, limit: int = MAX_VISIBLE_TEXT) -> str:
    text = str(value if value is not None else "")
    text = SECRET_ASSIGNMENT.sub(r"\1=[redacted]", text)
    text = CREDENTIAL.sub("[redacted-credential]", text)
    text = PRIVATE_SIZED_HEX.sub("[redacted-64]", text)
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def iso_time(milliseconds: int) -> str:
    timestamp = dt.datetime.fromtimestamp(milliseconds / 1000, tz=dt.timezone.utc)
    return timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def byte_size(size: int) -> str:
    if size >= 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size} B"


def short_hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()[:12]


def artifact_kind(path: str) -> str:
    suffix = Path(path).suffix.lower()
    if suffix in {".md", ".txt", ".pdf", ".doc", ".docx"}:
        return "document"
    if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        return "image"
    return "code"


def safe_path(value: Any, workspace: Path) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = Path(value.strip())
    try:
        return str(candidate.relative_to(workspace))
    except ValueError:
        return candidate.name or None


def parameter(label: str, value: Any, limit: int = MAX_VISIBLE_RESULT) -> dict[str, str]:
    return {"label": label, "value": redacted(value, limit)}


def first_command_line(command: str) -> str:
    first = next((line.strip() for line in command.splitlines() if line.strip()), "command")
    return redacted(first, 96)


def tool_parameters(tool: str, state: dict[str, Any], workspace: Path) -> tuple[list[dict[str, str]], list[str]]:
    inputs = state.get("input") if isinstance(state.get("input"), dict) else {}
    params: list[dict[str, str]] = []
    paths: list[str] = []

    if tool == "bash":
        command = inputs.get("command", "Command unavailable")
        params.append(parameter("Command", command))
        params.append(parameter("Working directory", workspace))
    elif tool == "read":
        path = safe_path(inputs.get("filePath") or inputs.get("path"), workspace)
        if path:
            params.append(parameter("Path", path))
        for key, label in (("offset", "Offset"), ("limit", "Limit")):
            if key in inputs:
                params.append(parameter(label, inputs[key]))
    elif tool in {"grep", "glob"}:
        if "pattern" in inputs:
            params.append(parameter("Pattern", inputs["pattern"]))
        path = safe_path(inputs.get("path"), workspace)
        if path:
            params.append(parameter("Path", path))
        if "include" in inputs:
            params.append(parameter("Include", inputs["include"]))
    elif tool == "skill":
        if "name" in inputs:
            params.append(parameter("Skill", inputs["name"]))
    elif tool in {"websearch", "webfetch"}:
        key = "query" if tool == "websearch" else "url"
        if key in inputs:
            params.append(parameter(key.title(), inputs[key]))
    elif tool == "task":
        if "description" in inputs:
            params.append(parameter("Description", inputs["description"]))
        if "subagent_type" in inputs:
            params.append(parameter("Agent type", inputs["subagent_type"]))
    elif tool == "apply_patch":
        patch = inputs.get("patchText") or inputs.get("patch") or ""
        if isinstance(patch, str):
            for match in PATCH_PATH.finditer(patch):
                path = safe_path(match.group(1), workspace)
                if path and path not in {"null", "dev/null"} and path not in paths:
                    paths.append(path)
    else:
        for key, label in (("path", "Path"), ("filePath", "Path"), ("name", "Name")):
            if key in inputs:
                params.append(parameter(label, inputs[key]))
                break

    return params, paths


def tool_title(tool: str, state: dict[str, Any]) -> str:
    inputs = state.get("input") if isinstance(state.get("input"), dict) else {}
    if tool == "bash":
        return f"Ran {first_command_line(str(inputs.get('command', 'command')))}"
    if tool == "apply_patch":
        return "Edited files"
    labels = {
        "read": "Read file",
        "grep": "Searched text",
        "glob": "Listed matching files",
        "skill": "Loaded skill",
        "task": "Delegated task",
        "todowrite": "Updated task plan",
        "webfetch": "Fetched web page",
        "websearch": "Searched the web",
    }
    title = state.get("title")
    return redacted(title, 120) if isinstance(title, str) and title.strip() else labels.get(tool, tool.replace("_", " ").title())


def tool_result(tool: str, state: dict[str, Any]) -> str | None:
    # File reads and patches can contain full source text. Their paths/status are
    # useful observability; their bodies never cross the exporter boundary.
    if tool in {"read", "apply_patch"}:
        return None
    output = state.get("output")
    if not isinstance(output, str) or not output.strip():
        return None
    return redacted(output.strip(), MAX_VISIBLE_RESULT)


def load_config(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError) as error:
        fail(f"cannot load exporter configuration: {error}")
    required = {"agentName", "agentPubkey", "database", "allowedChannels"}
    if not isinstance(config, dict) or not required.issubset(config):
        fail("exporter configuration is incomplete")
    return config


def select_trigger(connection: sqlite3.Connection, channel_id: str) -> tuple[Any, ...] | None:
    return connection.execute(
        """
        SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data
        FROM message AS m
        WHERE json_extract(m.data, '$.role') = 'user'
          AND EXISTS (
            SELECT 1 FROM part AS p
            WHERE p.message_id = m.id
              AND json_extract(p.data, '$.type') = 'text'
              AND instr(json_extract(p.data, '$.text'), ?) > 0
          )
        ORDER BY m.time_created DESC
        LIMIT 1
        """,
        (channel_id,),
    ).fetchone()


def build_page(config: dict[str, Any], channel_id: str) -> dict[str, Any]:
    database = Path(str(config["database"]))
    try:
        stat = database.stat()
    except OSError as error:
        fail(f"cannot inspect OpenCode database: {error}")
    if not database.is_file() or database.is_symlink() or stat.st_size > MAX_DATABASE_BYTES:
        fail("OpenCode database failed safety checks")

    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 1000")
    trigger = select_trigger(connection, channel_id)
    if trigger is None:
        fail("no matching OpenCode turn for the selected channel")

    message_id, session_id, started_ms, _, trigger_message_data = trigger
    session = connection.execute(
        """
        SELECT directory, model, time_updated, title, version
        FROM session WHERE id = ? LIMIT 1
        """,
        (session_id,),
    ).fetchone()
    if session is None:
        fail("matching OpenCode session is missing")
    directory, model_data, session_updated_ms, _, version = session
    workspace_path = Path(directory or "/")
    model = load_json(model_data, {})
    model_label = "/".join(
        value for value in (model.get("providerID"), model.get("id")) if isinstance(value, str)
    ) or "Not exposed"
    if isinstance(model.get("variant"), str):
        model_label += f" ({model['variant']})"

    trigger_parts = connection.execute(
        "SELECT data FROM part WHERE message_id = ? ORDER BY time_created",
        (message_id,),
    ).fetchall()
    trigger_bytes = b"\n".join(str(row[0]).encode("utf-8") for row in trigger_parts)
    session_fingerprint = json.dumps(
        {"session": session_id, "directory": directory, "model": model, "version": version},
        sort_keys=True,
    ).encode("utf-8")

    rows = connection.execute(
        """
        SELECT p.id, p.message_id, p.time_created, p.time_updated, p.data, m.data
        FROM part AS p
        JOIN message AS m ON m.id = p.message_id
        WHERE p.session_id = ? AND p.time_created >= ?
        ORDER BY p.time_created ASC, p.id ASC
        """,
        (session_id, started_ms),
    ).fetchall()

    activity: list[dict[str, Any]] = [
        {
            "id": f"{message_id}-started",
            "at": iso_time(started_ms),
            "kind": "lifecycle",
            "title": "Turn started",
            "detail": "The Doha OpenCode runtime accepted this Buzz turn.",
            "status": "complete",
            "parameters": [],
            "result": None,
        },
        {
            "id": f"{message_id}-request",
            "at": iso_time(started_ms),
            "kind": "lifecycle",
            "title": "Request received",
            "detail": "Trigger content withheld; provenance fingerprint recorded.",
            "status": "complete",
            "parameters": [],
            "result": None,
        },
    ]
    artifacts: list[dict[str, Any]] = []
    seen_artifacts: set[str] = set()
    latest_ms = started_ms

    for part_id, _, created_ms, updated_ms, part_data, message_data in rows:
        part = load_json(part_data, {})
        message = load_json(message_data, {})
        if message.get("role") != "assistant":
            continue
        latest_ms = max(latest_ms, int(updated_ms or created_ms or started_ms))
        kind = part.get("type")
        event: dict[str, Any] | None = None

        if kind == "reasoning":
            summary = part.get("text")
            if isinstance(summary, str) and summary.strip():
                event = {
                    "id": part_id,
                    "at": iso_time(int(created_ms)),
                    "kind": "lifecycle",
                    "title": "Thinking",
                    "detail": redacted(summary.strip()),
                    "status": "complete",
                    "parameters": [],
                    "result": None,
                }
        elif kind == "text":
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                final = message.get("finish") == "stop"
                event = {
                    "id": part_id,
                    "at": iso_time(int(created_ms)),
                    "kind": "message",
                    "title": "Result prepared" if final else "Progress update",
                    "detail": redacted(text.strip()),
                    "status": "complete",
                    "parameters": [],
                    "result": None,
                }
        elif kind == "tool":
            tool = str(part.get("tool") or "tool")
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            status = str(state.get("status") or "pending")
            mapped_status = "failed" if status in {"error", "failed"} else "complete" if status in {"completed", "complete"} else "running"
            params, changed_paths = tool_parameters(tool, state, workspace_path)
            for changed_path in changed_paths:
                if changed_path in seen_artifacts:
                    continue
                seen_artifacts.add(changed_path)
                artifacts.append(
                    {
                        "id": short_hash(changed_path.encode("utf-8")),
                        "kind": artifact_kind(changed_path),
                        "name": changed_path,
                        "detail": "Changed by the remote OpenCode runtime; contents withheld.",
                        "changedAt": iso_time(int(updated_ms or created_ms)),
                    }
                )
            event = {
                "id": part_id,
                "at": iso_time(int(created_ms)),
                "kind": "tool",
                "title": tool_title(tool, state),
                "detail": "Remote tool details are available below." if params else "Remote tool activity.",
                "status": mapped_status,
                "parameters": params,
                "result": tool_result(tool, state),
            }

        if event is not None:
            activity.append(event)

    now_ms = int(dt.datetime.now(tz=dt.timezone.utc).timestamp() * 1000)
    status = "working" if now_ms - latest_ms < 60_000 else "complete"
    if len(activity) > MAX_ACTIVITY:
        activity = activity[:2] + activity[-(MAX_ACTIVITY - 2) :]

    context = [
        {
            "id": f"{message_id}-trigger",
            "kind": "thread",
            "label": "Triggering Buzz turn",
            "detail": "The remote trigger was present; its content remains on Doha.",
            "hash": short_hash(trigger_bytes),
            "size": byte_size(len(trigger_bytes)),
            "visibility": "provenance",
        },
        {
            "id": f"{session_id}-runtime",
            "kind": "repository",
            "label": "Doha OpenCode runtime",
            "detail": "Session, workspace, model, and runtime metadata were supplied; raw instructions remain withheld.",
            "hash": short_hash(session_fingerprint),
            "size": byte_size(len(session_fingerprint)),
            "visibility": "provenance",
        },
    ]
    evidence = [
        {
            "stage": "local",
            "label": "Doha runtime observed",
            "detail": "A source-redacted OpenCode workstream was read through Tailscale SSH.",
            "complete": True,
        },
        *[
            {
                "stage": stage,
                "label": label,
                "detail": "No explicit signed evidence was supplied by this runtime source.",
                "complete": False,
            }
            for stage, label in (
                ("committed", "Commit evidence"),
                ("pushed", "Push evidence"),
                ("pr-open", "Pull request evidence"),
                ("merged", "Merge evidence"),
                ("deployed", "Deployment evidence"),
            )
        ],
    ]

    connection.close()
    return {
        "channelId": channel_id,
        "agentPubkey": config["agentPubkey"],
        "agentName": config["agentName"],
        "sessionId": session_id,
        "turnId": message_id,
        "status": status,
        "startedAt": iso_time(int(started_ms)),
        "completedAt": None if status == "working" else iso_time(int(latest_ms or session_updated_ms)),
        "model": redacted(model_label, 120),
        "workspace": workspace_path.name or "remote-workspace",
        "activity": activity,
        "context": context,
        "evidence": evidence,
        "artifacts": artifacts[:100],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--channel-id", required=True)
    parser.add_argument("--agent-pubkey", required=True)
    parser.add_argument("--agent-name", required=True)
    args = parser.parse_args()

    config = load_config(args.config)
    if not CHANNEL_ID.fullmatch(args.channel_id):
        fail("invalid channel identifier")
    if not PUBKEY.fullmatch(args.agent_pubkey):
        fail("invalid agent public key")
    if args.agent_pubkey != config["agentPubkey"] or args.agent_name != config["agentName"]:
        fail("requested agent does not match this exporter")
    if args.channel_id not in config["allowedChannels"]:
        fail("requested channel is not allowed by this exporter")

    page = build_page(config, args.channel_id)
    json.dump(page, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
