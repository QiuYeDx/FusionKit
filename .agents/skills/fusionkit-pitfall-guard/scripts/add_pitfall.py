#!/usr/bin/env python3
"""Create a FusionKit pitfall detail file and append it to the index."""

from __future__ import annotations

import argparse
import datetime as _dt
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCES = ROOT / "references"
INDEX = REFERENCES / "index.md"


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "pitfall"


def next_id(index_text: str) -> str:
    numbers = [
        int(match.group(1))
        for match in re.finditer(r"FK-PIT-(\d{4})", index_text)
    ]
    return f"FK-PIT-{(max(numbers) + 1) if numbers else 1:04d}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True)
    parser.add_argument("--area", required=True)
    parser.add_argument("--triggers", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--date", default=_dt.date.today().isoformat())
    args = parser.parse_args()

    REFERENCES.mkdir(parents=True, exist_ok=True)
    index_text = INDEX.read_text(encoding="utf-8") if INDEX.exists() else ""
    pitfall_id = next_id(index_text)
    filename = f"{slugify(args.title)}.md"
    path = REFERENCES / filename

    if path.exists():
        raise SystemExit(f"Refusing to overwrite existing pitfall: {path}")

    path.write_text(
        f"""# {pitfall_id}: {args.title}

## Area

{args.area}

## Triggers

{args.triggers}

## Symptoms

{args.summary}

## Root cause

TODO

## Do

TODO

## Avoid

TODO

## Validation

TODO

## Related files

TODO
""",
        encoding="utf-8",
    )

    row = (
        f"| {pitfall_id} | {args.area} | {args.triggers}; {args.summary} | "
        f"[{filename}]({filename}) |"
    )

    if not index_text:
        index_text = (
            "# FusionKit pitfall index\n\n"
            "| ID | Area | Triggers / symptoms | Detail |\n"
            "| --- | --- | --- | --- |\n"
        )

    if row not in index_text:
        lines = index_text.rstrip().splitlines()
        insert_at = len(lines)
        for idx, line in enumerate(lines):
            if line.startswith("| FK-PIT-"):
                insert_at = idx + 1
        lines.insert(insert_at, row)
        INDEX.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
