#!/usr/bin/env python3
"""Migrate a pi-friend-memory store to the history tree.

Before this migration a store kept old things in five places: tombstones under
nodes/superseded/, recovery records under recovery/, sweep snapshots under
sweeps/preimages/, expired tombstones under sweeps/archived/, and dropped
candidates under sweeps/dropped/. One history/ directory replaces all of them,
and node bodies no longer carry an audit section.

Everything this script does is listed in steps() below, each step printed whether
it ran, was skipped, or failed. A file that fails is left exactly where it was
and the run continues; the failure does not stop the step.

Run it with no arguments to migrate the default store, or read --help.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Keys removed from the configuration because the code no longer reads them.
DEPRECATED_CONFIG_KEYS = (
    "tombstone_grace_days",
    "preimage_keep",
)

AUDIT_HEADING = re.compile(r"^##[ \t]+audit[ \t]*$", re.IGNORECASE | re.MULTILINE)


@dataclass
class Report:
    """Collects per-step counts so the summary can be printed at the end."""

    moved: int = 0
    skipped: int = 0
    failed: list[str] = field(default_factory=list)


def say(line: str) -> None:
    print(line, flush=True)


def expand(path: str) -> Path:
    return Path(path).expanduser().resolve()


def agent_dir() -> Path:
    configured = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
    return expand(configured) if configured else expand("~/.pi/agent")


def default_config_path() -> Path:
    return agent_dir() / "pi-friend" / "pi-friend-memory.yml"


def read_config_text(config_path: Path) -> str | None:
    try:
        return config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as error:
        say(f"[warn] Could not read {config_path}: {error}")
        return None


def config_memory_root(config_path: Path) -> Path | None:
    """Finds memory.root without a YAML parser.

    Only two shapes matter here: `memory:\n  root: …` and a flat `root:` line
    inside the memory block. Anything more elaborate falls back to the caller's
    default, which is where the extension puts a store with no configuration.
    """
    text = read_config_text(config_path)
    if text is None:
        return None
    in_memory = False
    memory_indent = 0
    for raw in text.splitlines():
        if raw.strip().startswith("#") or raw.strip() == "":
            continue
        indent = len(raw) - len(raw.lstrip())
        stripped = raw.strip()
        if indent == 0:
            in_memory = stripped == "memory:" or stripped.startswith("memory: #")
            memory_indent = indent
            continue
        if not in_memory or indent <= memory_indent:
            continue
        if stripped.startswith("root:"):
            value = stripped.split(":", 1)[1].strip().strip("'\"")
            if value:
                return expand(value)
            return None
    return None


def split_front_matter(text: str) -> tuple[str, str] | None:
    """Splits a node file into (front matter including delimiters, body)."""
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None
    return text[: end + len("\n---\n")], text[end + len("\n---\n") :]


def convert_tombstone(text: str) -> str:
    """Turns a tombstone back into the node as it was before deletion.

    The deletion rewrote three front-matter fields and appended an audit section
    describing itself. Reversing the fields is exact; reversing the audit section
    is not possible, so it is removed like every other audit section.
    """
    parts = split_front_matter(text)
    if parts is None:
        raise ValueError("no front matter")
    front, body = parts
    front = re.sub(
        r"(?m)^status:[ \t]*superseded[ \t]*$", "status: active", front
    )
    front = re.sub(
        r"(?m)^decay_weight:[ \t]*0(?:\.0+)?[ \t]*$", "decay_weight: 1", front
    )
    front = re.sub(
        r"(?m)^superseded_by:[ \t]*.*$", 'superseded_by: ""', front
    )
    body = strip_audit_section(body)
    return front + body


def strip_audit_section(body: str) -> str:
    """Removes the audit section and everything after it."""
    match = AUDIT_HEADING.search(body)
    if match is None:
        return body
    trimmed = body[: match.start()].rstrip()
    return f"{trimmed}\n" if trimmed else ""


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def move_file(source: Path, destination: Path) -> None:
    ensure_parent(destination)
    shutil.move(str(source), str(destination))


def step_tombstones(store: Path, report: Report) -> None:
    source_dir = store / "nodes" / "superseded"
    files = sorted(source_dir.glob("*.md")) if source_dir.is_dir() else []
    if not files:
        say("[skip] nodes/superseded/: no tombstones to move")
        return
    for source in files:
        destination = store / "history" / "deleted" / source.name
        try:
            if destination.exists():
                raise FileExistsError(f"{destination.relative_to(store)} exists")
            move_file_with_conversion(source, destination)
            report.moved += 1
        except Exception as error:  # noqa: BLE001 - one bad file must not stop the run
            report.failed.append(f"nodes/superseded/{source.name}: {error}")
            say(f"[fail] nodes/superseded/{source.name}: {error} (left in place)")
    say(
        f"[done] Moved {report.moved} deletion(s) from nodes/superseded/ to history/deleted/"
    )


def move_file_with_conversion(source: Path, destination: Path) -> None:
    text = source.read_text(encoding="utf-8")
    converted = convert_tombstone(text)
    ensure_parent(destination)
    destination.write_text(converted, encoding="utf-8")
    source.unlink()


def step_drops(store: Path, report: Report) -> None:
    source_dir = store / "sweeps" / "dropped"
    files = sorted(source_dir.rglob("*.md")) if source_dir.is_dir() else []
    if not files:
        say("[skip] sweeps/dropped/: no dropped candidates to move")
        return
    # The old layout is one directory per run, so the same slug can appear more
    # than once. The newest copy is the one that was dropped most recently.
    newest: dict[str, Path] = {}
    for path in files:
        existing = newest.get(path.name)
        if existing is None or path.stat().st_mtime > existing.stat().st_mtime:
            newest[path.name] = path
    duplicates = len(files) - len(newest)
    moved = 0
    for name, source in sorted(newest.items()):
        destination = store / "history" / "dropped" / name
        try:
            if destination.exists():
                raise FileExistsError(f"{destination.relative_to(store)} exists")
            move_file(source, destination)
            moved += 1
        except Exception as error:  # noqa: BLE001
            report.failed.append(f"sweeps/dropped/{name}: {error}")
            say(f"[fail] sweeps/dropped/{source.parent.name}/{name}: {error}")
    say(f"[done] Moved {moved} dropped candidate(s) to history/dropped/")
    if duplicates:
        say(
            f"[note] {duplicates} older copy of an already-moved slug will be removed with sweeps/dropped/"
        )


def step_audit(store: Path, report: Report) -> None:
    candidates = sorted((store / "nodes").glob("*.md")) if (store / "nodes").is_dir() else []
    staging = (store / "staging").glob("*.md") if (store / "staging").is_dir() else []
    files = [*candidates, *sorted(staging)]
    stripped = 0
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
            parts = split_front_matter(text)
            if parts is None:
                continue
            front, body = parts
            cleaned = strip_audit_section(body)
            if cleaned == body:
                continue
            path.write_text(front + cleaned, encoding="utf-8")
            stripped += 1
        except Exception as error:  # noqa: BLE001
            report.failed.append(f"{path.relative_to(store)}: {error}")
            say(f"[fail] {path.relative_to(store)}: {error} (left unchanged)")
    if stripped == 0:
        say("[skip] No audit sections found in nodes/ or staging/")
    else:
        say(
            f"[done] Stripped audit sections from {stripped} file(s); that text was history, not memory, and cannot be reconstructed"
        )


def step_remove(
    store: Path,
    relative: str,
    label: str,
    report: Report,
    only_when_empty: bool = False,
) -> None:
    target = store / relative
    if not target.exists():
        say(f"[skip] {relative}/: already absent")
        return
    if only_when_empty:
        remaining = sorted(target.rglob("*.md"))
        if remaining:
            say(
                f"[skip] {relative}/: {len(remaining)} file(s) still there after earlier failures; left in place"
            )
            return
    try:
        shutil.rmtree(target)
        say(f"[done] Removed {label} ({relative}/)")
    except Exception as error:  # noqa: BLE001
        report.failed.append(f"{relative}/: {error}")
        say(f"[fail] {relative}/: {error} (left in place)")


def step_config(config_path: Path, report: Report) -> None:
    text = read_config_text(config_path)
    if text is None:
        say(f"[skip] {config_path}: no configuration file")
        return
    lines = text.splitlines(keepends=True)
    kept: list[str] = []
    removed: list[str] = []
    # Only the memory.sweep block is considered: these names are specific
    # enough that a match anywhere would probably be the right line, but a
    # migration is not the place to guess.
    in_memory = False
    in_sweep = False
    memory_indent = 0
    sweep_indent = 0
    for line in lines:
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped and not stripped.startswith("#"):
            if indent == 0:
                in_memory = stripped == "memory:" or stripped.startswith("memory: #")
                memory_indent = indent
                in_sweep = False
            elif in_memory and indent > memory_indent:
                if stripped == "sweep:" or stripped.startswith("sweep: #"):
                    in_sweep = True
                    sweep_indent = indent
                elif in_sweep and indent <= sweep_indent:
                    in_sweep = False
            else:
                in_sweep = False
        name = stripped.split(":", 1)[0] if ":" in stripped else ""
        if in_sweep and name in DEPRECATED_CONFIG_KEYS and stripped.startswith(name + ":"):
            removed.append(name)
            continue
        kept.append(line)
    if not removed:
        say(f"[skip] {config_path}: no deprecated options")
        return
    try:
        backup = config_path.with_suffix(config_path.suffix + ".bak")
        if not backup.exists():
            backup.write_text(text, encoding="utf-8")
        config_path.write_text("".join(kept), encoding="utf-8")
        for name in removed:
            say(f"[done] Removed deprecated option `{name}` from {config_path}")
        say(f"[done] Original configuration kept at {backup}")
    except Exception as error:  # noqa: BLE001
        report.failed.append(f"{config_path}: {error}")
        say(f"[fail] {config_path}: {error} (left unchanged)")


def count_files(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return sum(1 for path in directory.rglob("*") if path.is_file())


def describe(store: Path, config_path: Path) -> None:
    say("")
    say("This will:")
    say("  - move nodes/superseded/*.md into history/deleted/ as active nodes")
    say("  - move sweeps/dropped/**/*.md into history/dropped/")
    say("  - remove ## audit sections from nodes/ and staging/")
    say("  - delete recovery/, sweeps/archived/, sweeps/preimages/, sweeps/dropped/")
    say("  - delete nodes/superseded/ once it is empty")
    say("  - remove deprecated options from the configuration")
    say("")
    say("Two things cannot be undone:")
    say("  - Audit sections are history, not memory, and cannot be reconstructed. They are discarded.")
    say("  - Preimages are the only remaining copy of versions written before history/")
    say("    existed. They are discarded, so older edit history is lost for good.")
    say("")
    say(f"Store:  {store}")
    say(f"Config: {config_path}")
    say(
        f"Found:  {count_files(store / 'nodes' / 'superseded')} tombstone(s), "
        f"{count_files(store / 'sweeps' / 'dropped')} dropped file(s), "
        f"{count_files(store / 'recovery')} recovery record(s), "
        f"{count_files(store / 'sweeps' / 'preimages')} preimage file(s)"
    )
    say("")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Migrate a pi-friend-memory store to the history tree.",
    )
    parser.add_argument(
        "--store",
        help="memory root (default: memory.root from the config, else <agent-dir>/pi-friend/memory)",
    )
    parser.add_argument(
        "--config",
        help="pi-friend-memory.yml (default: <agent-dir>/pi-friend/pi-friend-memory.yml)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be done and change nothing",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="skip the confirmation prompt (for scripted runs)",
    )
    args = parser.parse_args(argv)

    config_path = expand(args.config) if args.config else default_config_path()
    if args.store:
        store = expand(args.store)
    else:
        store = config_memory_root(config_path) or (
            config_path.parent / "memory"
        ).resolve()

    if not store.is_dir():
        say(f"No memory store at {store}.")
        return 2

    report = Report()
    describe(store, config_path)
    if args.dry_run:
        say("[dry-run] Nothing was changed.")
        return 0
    if not args.yes:
        answer = input("Continue? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            say("Nothing was changed.")
            return 1

    say("")
    step_tombstones(store, report)
    step_drops(store, report)
    step_audit(store, report)
    step_remove(store, "recovery", "recovery records", report)
    step_remove(store, "sweeps/archived", "archived tombstones", report)
    step_remove(store, "sweeps/preimages", "sweep snapshots", report)
    step_remove(
        store,
        "sweeps/dropped",
        "dropped candidate directories",
        report,
        only_when_empty=True,
    )
    step_remove(
        store,
        "nodes/superseded",
        "the superseded directory",
        report,
        only_when_empty=True,
    )
    step_config(config_path, report)

    say("")
    if report.failed:
        say(f"Finished with {len(report.failed)} failure(s):")
        for failure in report.failed:
            say(f"  - {failure}")
        return 1
    say("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
