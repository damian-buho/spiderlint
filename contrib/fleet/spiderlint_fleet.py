#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Audit several targets with spiderlint concurrently and aggregate the reports.

Standard library only, no build step, and it shells out to the spiderlint CLI, so
it works wherever spiderlint and Python 3.11+ both run.

Each target is one `spiderlint --format json` child. Children run under a bounded
worker pool so a fleet of fifty sites does not open fifty browsers at once, and
each child's stdout is streamed to a temporary file rather than held in memory,
because a json report for a large crawl is routinely tens of megabytes.

    python3 contrib/fleet/spiderlint_fleet.py https://a.example https://b.example
    python3 contrib/fleet/spiderlint_fleet.py --jobs 4 --rules recommended $(cat targets.txt)

Exit status is 0 when every target produced a parseable report and 1 when a child
produced none, so it is usable as a CI step directly. Each target's own spiderlint
exit code is reported per row rather than folded into the fleet status, because a
non-zero child exit can mean findings were present, or that the site was never
reached; `pages` in the row tells those apart.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_JOBS = min(4, (os.cpu_count() or 2))


def audit_one(
    target: str,
    *,
    spiderlint_bin: str,
    max_pages: int | None,
    rules: str,
    per_target_concurrency: int,
    timeout_s: float,
) -> dict[str, object]:
    """Run one spiderlint child and return its parsed report plus timing.

    The child writes json to a temporary file instead of a pipe. A pipe would
    need draining on this side while the child blocks on a full buffer, and the
    reports are large enough for that to matter.
    """
    argv = [
        spiderlint_bin,
        "audit",
        target,
        "--format",
        "json",
        "--rules",
        rules,
        "--concurrency",
        str(per_target_concurrency),
    ]
    if max_pages is not None:
        argv += ["--max-pages", str(max_pages)]

    started = time.perf_counter()
    with tempfile.TemporaryFile(prefix="spiderlint-fleet-", suffix=".json") as sink:
        try:
            completed = subprocess.run(  # noqa: S603 - argv list, no shell
                argv,
                stdout=sink,
                stderr=subprocess.PIPE,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                "target": target,
                "ok": False,
                "error": f"timed out after {timeout_s:g}s",
                "wall_ms": round((time.perf_counter() - started) * 1000, 1),
            }

        wall_ms = round((time.perf_counter() - started) * 1000, 1)
        size = sink.tell()
        sink.seek(0)

        if completed.returncode != 0 and size == 0:
            stderr = completed.stderr.decode("utf-8", "replace").strip()
            return {
                "target": target,
                "ok": False,
                "exit_code": completed.returncode,
                "error": stderr.splitlines()[-1] if stderr else "no output",
                "wall_ms": wall_ms,
            }

        try:
            report = json.load(sink)
        except json.JSONDecodeError as exc:
            return {
                "target": target,
                "ok": False,
                "error": f"report was not json: {exc}",
                "report_bytes": size,
                "wall_ms": wall_ms,
            }

    return {
        "target": target,
        "ok": True,
        "exit_code": completed.returncode,
        "report_bytes": size,
        "wall_ms": wall_ms,
        "report": report,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit several targets with spiderlint concurrently and aggregate the reports.",
    )
    parser.add_argument("targets", nargs="+", help="URLs or domains to audit")
    parser.add_argument(
        "--bin",
        default=shutil.which("spiderlint") or "spiderlint",
        help="Path to the spiderlint CLI (default: first on PATH)",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=DEFAULT_JOBS,
        help=f"Targets in flight at once (default: {DEFAULT_JOBS}). Each one is a browser, so raise it deliberately.",
    )
    parser.add_argument("--max-pages", type=int, default=None, help="Max pages per target")
    parser.add_argument("--rules", default="recommended", help="Ruleset or rule IDs passed through to spiderlint")
    parser.add_argument("--concurrency", type=int, default=2, help="Per-target HTTP concurrency")
    parser.add_argument("--timeout", type=float, default=900.0, help="Per-target timeout in seconds")
    parser.add_argument(
        "--full-reports",
        action="store_true",
        help="Include each full report in the output instead of a per-target summary",
    )
    parser.add_argument("--out", type=Path, default=None, help="Write the aggregate json here instead of stdout")
    args = parser.parse_args()

    if args.jobs < 1:
        parser.error("--jobs must be at least 1")
    if not shutil.which(args.bin) and not Path(args.bin).exists():
        parser.error(f"spiderlint not found at {args.bin!r}; pass --bin")

    started = time.perf_counter()
    rows: list[dict[str, object]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        # Threads, not processes: each worker only waits on a child, so the GIL is
        # released for the whole scan and a process pool would add no throughput.
        futures = {
            pool.submit(
                audit_one,
                target,
                spiderlint_bin=args.bin,
                max_pages=args.max_pages,
                rules=args.rules,
                per_target_concurrency=args.concurrency,
                timeout_s=args.timeout,
            ): target
            for target in args.targets
        }
        for future in concurrent.futures.as_completed(futures):
            rows.append(future.result())

    rows.sort(key=lambda row: args.targets.index(str(row["target"])))

    if not args.full_reports:
        for row in rows:
            report = row.pop("report", None)
            if not isinstance(report, dict):
                continue
            findings = report.get("findings")
            row["findings"] = len(findings) if isinstance(findings, list) else None
            # `pages` distinguishes "audited and found nothing" from "never
            # reached the site": an unreachable target still writes a parseable
            # report, with zero findings and zero pages.
            summary = report.get("summary")
            if isinstance(summary, dict) and "pages" in summary:
                row["pages"] = summary["pages"]

    failed = [row for row in rows if not row["ok"]]
    aggregate = {
        "fleet_wall_ms": round((time.perf_counter() - started) * 1000, 1),
        "jobs": args.jobs,
        "targets": len(rows),
        "failed": len(failed),
        "results": rows,
    }

    text = json.dumps(aggregate, indent=2)
    if args.out is not None:
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)

    for row in failed:
        print(f"spiderlint-fleet: {row['target']}: {row.get('error')}", file=sys.stderr)

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
