---
name: fusionkit-pitfall-guard
description: Project-level pitfall and avoidance workflow for FusionKit. Use when Codex is diagnosing failures, implementing UI/Electron/build/i18n changes, encountering surprising behavior, before repeating a risky workflow, or when the user mentions 踩坑, 避坑, pitfall, gotcha, regression, flaky validation, visual QA, Electron screenshots, frontend services, or project-specific lessons learned.
---

# FusionKit Pitfall Guard

## Overview

Use this skill to prevent repeated FusionKit mistakes. It provides a lightweight pitfall index and one-file-per-case references so Codex can quickly check for known traps before acting, then load only the relevant detail documents.

## Required workflow

1. Read `references/index.md` first.
2. Match the current task against the index by area, trigger words, symptoms, and files.
3. Read only the referenced pitfall detail files that plausibly apply.
4. Apply the “Do / Avoid / Validation” guidance from those files.
5. If the current task reveals a new reusable lesson, add a new pitfall detail file and update the index before finishing.
6. Mention in the final response when this skill materially changed the approach.

## Adding a new pitfall

Prefer using the helper script:

```bash
python3 .agents/skills/fusionkit-pitfall-guard/scripts/add_pitfall.py \
  --title "Short pitfall title" \
  --area "Frontend / Electron / Docs / Build / i18n" \
  --triggers "comma-separated trigger words" \
  --summary "One-line symptom and lesson"
```

Then edit the generated detail file and fill in the concrete context, do/avoid guidance, and validation commands.

If the script is not suitable, manually create a Markdown file directly under `references/` and add a row to `references/index.md`. Keep detail files one level below `references/`; do not bury cases in nested directories.

## Detail file contract

Each pitfall detail file should include:

- `Area`
- `Triggers`
- `Symptoms`
- `Root cause`
- `Do`
- `Avoid`
- `Validation`
- `Related files`

Keep each case focused on one reusable lesson. If one incident produced several independent lessons, split them into several detail files and link all of them from the index.

## Repository-specific defaults

- Before using visual screenshots as proof, check whether FusionKit’s global preload loading screen has fully exited.
- Before ending any turn that starts Vite/Electron/frontend services, close them and confirm the process table is clean.
- For UI detail page work, prefer Electron-based validation over plain browser validation because the app depends on preload APIs.
- For i18n-sensitive changes, run the project i18n check when user-facing strings or locale keys may be affected.

## References

- Pitfall index: `references/index.md`
- New pitfall helper: `scripts/add_pitfall.py`
