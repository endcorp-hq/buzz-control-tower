#!/usr/bin/env python3
"""Run a fixed, root-owned fleet export plan and emit bounded workstreams.

The desktop invokes this program without arguments. All source commands,
expected identities, and channel bindings come from a root-owned configuration
file. A failed or deliberately disabled source becomes an explicit unavailable
record; it never prevents healthy agent pages from being returned.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = "/etc/control-tower/fleet-exporter.json"
MAX_SOURCE_DOCUMENT = 2 * 1024 * 1024
MAX_SOURCES = 16
SOURCE_TIMEOUT_SECONDS = 8


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def load_config(path: str) -> dict[str, Any]:
    try:
        config_path = Path(path)
        stat = config_path.stat()
        if not config_path.is_file() or config_path.is_symlink() or stat.st_size > 256 * 1024:
            fail("fleet configuration failed safety checks")
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"cannot load fleet configuration: {error}")
    if not isinstance(config, dict) or not isinstance(config.get("sources"), list):
        fail("fleet configuration is incomplete")
    if not 1 <= len(config["sources"]) <= MAX_SOURCES:
        fail("fleet configuration has an invalid source count")
    return config


def unavailable(source: dict[str, Any], detail: str) -> dict[str, str]:
    return {
        "agentPubkey": str(source.get("agentPubkey", "")),
        "agentName": str(source.get("agentName", "Unknown agent")),
        "sourceLabel": str(source.get("sourceLabel", "Remote runtime")),
        "detail": detail[:240],
    }


def validate_source(source: Any) -> dict[str, Any]:
    if not isinstance(source, dict):
        fail("fleet source is not an object")
    for key in ("agentPubkey", "agentName", "sourceLabel"):
        if not isinstance(source.get(key), str) or not source[key]:
            fail(f"fleet source is missing {key}")
    command = source.get("command")
    disabled = source.get("disabledReason")
    if command is None and isinstance(disabled, str) and disabled:
        return source
    if (
        not isinstance(command, list)
        or not command
        or len(command) > 32
        or not all(isinstance(item, str) and item and len(item) <= 512 for item in command)
        or not str(command[0]).startswith("/")
    ):
        fail("fleet source command is not a fixed absolute argv")
    return source


def run_source(source: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    disabled = source.get("disabledReason")
    if isinstance(disabled, str) and disabled:
        return None, unavailable(source, disabled)
    try:
        completed = subprocess.run(
            source["command"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=SOURCE_TIMEOUT_SECONDS,
            check=False,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None, unavailable(source, "Runtime exporter is unreachable or timed out.")
    if completed.returncode != 0 or not completed.stdout or len(completed.stdout) > MAX_SOURCE_DOCUMENT:
        return None, unavailable(source, "Runtime exporter returned no valid workstream.")
    try:
        page = json.loads(completed.stdout)
    except ValueError:
        return None, unavailable(source, "Runtime exporter returned malformed data.")
    if (
        not isinstance(page, dict)
        or page.get("agentPubkey") != source["agentPubkey"]
        or page.get("agentName") != source["agentName"]
        or page.get("sourceLabel") != source["sourceLabel"]
    ):
        return None, unavailable(source, "Runtime exporter identity did not match its fixed source.")
    return page, None


def export_fleet(config: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    sources = [validate_source(source) for source in config["sources"]]
    pages: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(6, len(sources))) as executor:
        futures = {executor.submit(run_source, source): index for index, source in enumerate(sources)}
        ordered: dict[int, tuple[dict[str, Any] | None, dict[str, str] | None]] = {}
        for future in as_completed(futures):
            ordered[futures[future]] = future.result()
    for index in range(len(sources)):
        page, error = ordered[index]
        if page is not None:
            pages.append(page)
        if error is not None:
            errors.append(error)
    return {"pages": pages, "errors": errors}


def main() -> None:
    config_path = os.environ.get("CONTROL_TOWER_FLEET_CONFIG", DEFAULT_CONFIG)
    document = export_fleet(load_config(config_path))
    json.dump(document, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
