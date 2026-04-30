# abs-librarian

Reorganizes an [Audiobookshelf](https://www.audiobookshelf.org/) library to the expected directory structure:

```
Author Name/
  Standalone Book/
    audiofile.mp3
  Series Name/
    01 - Book Title/
      audiofile.mp3
```

Runs in two phases: **dry-run** (generates a plan you review) then **execute** (applies it). Never deletes real audio files.

---

## Prerequisites

Node.js 18+ and npm:

```bash
npm install
```

---

## Quickstart

### CLI only

```bash
# 1. Generate the plan (no files touched)
node reorganize.mjs --root /path/to/Audiobooks

# 2. Review
cat /path/to/Audiobooks/REORGANIZATION_GLOSSARY.md

# 3. Execute
node reorganize.mjs --root /path/to/Audiobooks --execute
```

You can set `AUDIOBOOKS_ROOT` to avoid repeating the path:

```bash
export AUDIOBOOKS_ROOT=/mnt/user/Audiobooks
node reorganize.mjs          # dry-run
node reorganize.mjs --execute
```

### With the web GUI

```bash
npm run build:gui             # one-time build (or after pulling changes)
node gui.mjs                  # opens http://localhost:7000
```

The GUI lets you review, approve, and customize the plan interactively, and has buttons to trigger dry-run and execute directly from the browser.

---

## Web GUI

```bash
node gui.mjs [--port 7000] [--no-open]
```

**Features:**

- **Dry Run / Execute buttons** — run scans and apply the plan from the browser; live output streams to a built-in terminal log
- **Approve / skip** individual moves or entire groups (grouped by author → book → disc)
- **Batch select** — shift-click a range, then approve or skip in one click
- **Best-guess resolution** — accept the suggested destination, use `_NeedsReview/`, or pick a custom path with a directory browser
- **Duplicate resolution** — side-by-side file comparison (size, bitrate, duration, codec, ID3 tags) with an auto-recommendation; confirm which copy to keep and a delete item is added to the plan automatically
- **Execute options** — checkboxes for all execute flags; the GUI remembers which flags you had active

All plan changes write back to `plan.json` immediately. The CLI and GUI can be used together — the CLI respects `approved`/`skipped` statuses set by the GUI.

**Dev mode (hot reload):**

```bash
npm run dev
```

Starts both the API server (nodemon, port 7000) and Vite dev server (port 5173) concurrently. Open `http://localhost:5173`.

---

## Execute Flags

| Flag | Effect |
|---|---|
| `--root <path>` | Path to Audiobooks root (default: `$AUDIOBOOKS_ROOT` or `/mnt/user/Audiobooks`) |
| `--execute` | Apply all pending/approved moves from plan.json |
| `--auto-accept-review` | Use best-guess destinations instead of `_NeedsReview/` |
| `--delete-junk` | Delete system files, Mac metadata, empty dirs, download artifacts |
| `--delete-empty-shells` | After moves, recursively remove dirs containing no audio |
| `--force-delete-audio-junk` | Bypass audio-extension safety check (rarely needed; `._*` forks are auto-detected) |
| `--retry-failed` | Retry items that failed in a previous execute run |
| `--ignore-file <path>` | Custom ignore file (default: `<root>/.audiobooksignore`) |

**Recommended (full cleanup):**

```bash
node reorganize.mjs --root /path/to/Audiobooks --execute --auto-accept-review --delete-junk --delete-empty-shells
```

**Conservative (moves only):**

```bash
node reorganize.mjs --root /path/to/Audiobooks --execute
```

---

## Plan Item Statuses

| Status | Meaning |
|---|---|
| `pending` | Not yet reviewed — CLI will execute this item |
| `approved` | Explicitly confirmed in the GUI — CLI will execute this item |
| `skipped` | Denied/skipped — CLI will not process this item |
| `done` | Successfully executed |
| `failed` | Execution failed; use `--retry-failed` to retry |

---

## The Ignore File

Copy `.audiobooksignore.example` to your Audiobooks root as `.audiobooksignore` and edit it:

```bash
cp .audiobooksignore.example /path/to/Audiobooks/.audiobooksignore
```

The format works like `.gitignore`:

```
# Trailing / = directories only
Encrypted/

# No slash = match any path component at any depth
.stfolder

# Full path pattern (contains /)
some/specific/path
```

Paths matched by an ignore rule are left untouched and listed in the glossary Skipped section.

---

## What Happens to Each File Type

| Item | Without `--delete-junk` | With `--delete-junk` |
|---|---|---|
| Confirmed / approved moves | Applied | Applied |
| Best-guess items | → `_NeedsReview/` | → `_NeedsReview/` |
| Best-guess + `--auto-accept-review` | → best-guess dest | → best-guess dest |
| System files (`.DS_Store`, `._*`, etc.) | Left in place | Deleted |
| Download artifacts (`.nzb`, `.sfv`, `.URL`) | → `_misc/` subfolder | Deleted |
| Empty directories | Left in place | Deleted |
| Duplicates | Left in place (flagged) | Left in place |
| Ignore-matched paths | Always left in place | Always left in place |
| `._*.mp3` Mac resource forks | Left in place | Deleted (auto-detected as non-audio) |

---

## After Execution

**Review `_NeedsReview/`** — files the script couldn't confidently place. The GUI's best-guess section or manual moves handle these.

**Resolve duplicates** — use the GUI's Duplicates section to compare files and mark which to keep, or handle manually.

**Rescan Audiobookshelf** — Settings → Libraries → (your library) → Scan Library.

---

## Restartability

`plan.json` is written after every item during execute. Interrupt at any time and re-run `--execute` to pick up where it left off. Add `--retry-failed` to also retry failed items.

---

## Execute Log

Each execute run appends to `execute.log` next to the script:

```
=== EXECUTE RUN: 2026-04-30T06:08:00Z ===
Flags: --execute --auto-accept-review --delete-junk --delete-empty-shells
Items: 350 pending

DONE   renamed  Aasif Mandvi → Aasif Mandvi/Sakina's Restaurant
DONE   deleted  John Ringo/Strands of Sorrow/._foo.mp3
FAIL   move     SomeBook: some error message
--- SUMMARY: 349 done, 0 skipped, 1 failed ---
```

---

## Special Cases Handled Automatically

- **Lee Child / Jack Reacher** — double-nested `Lee.Child.-.Jack.Reacher.NN.-.Title/` folders collapsed to `Lee Child/Jack Reacher/NN - Title/`
- **Marion Chesney** — Agatha Raisin (`AR##`) and Hamish Macbeth (`HM##`) series codes parsed from folder names; partial disc folders (`XofY`) become `Disc N` subfolders
- **Root-level MP3s** — ID3 tags read first; falls back to OpenLibrary API; ambiguous results → `_NeedsReview/`
- **Loose audio in author folders** — wrapped in a per-book subfolder using the ID3 album tag as the title
- **Top-level book folders** — remapped to `Author/Title/` using a known-mapping table plus ID3 verification
- **Mac AppleDouble resource forks** (`._*.mp3`) — always treated as junk regardless of extension

---

## Files

| Path | Purpose |
|---|---|
| `reorganize.mjs` | CLI entry point (thin wrapper) |
| `gui.mjs` | GUI server entry point |
| `src/cli.mjs` | Commander-based CLI — arg parsing, orchestrates core modules |
| `src/gui-server.mjs` | Express API server + process runner (spawns dry-run/execute, SSE streaming) |
| `src/core/constants.mjs` | `HARD_SKIP`, extension sets, `KNOWN_MISPLACED` |
| `src/core/fs-utils.mjs` | `safeMove`, `deleteItem`, `copyTree`, `cleanEmptyShells`, `isAudio`, `statOf`, etc. |
| `src/core/ignore.mjs` | `loadIgnoreFile`, `matchedIgnoreRule` |
| `src/core/metadata.mjs` | `readTags` (with full ID3/format mode), `recommendDuplicate`, `searchOpenLibrary` |
| `src/core/plan.mjs` | `readPlan`, `writePlan` (atomic), `createPlanState`, `writeGlossary` |
| `src/core/scanner.mjs` | `runDryScan` — three-pass scan, all special handlers |
| `src/core/executor.mjs` | `runExecute` — processes plan items, writes execute.log |
| `gui/` | Vite + React frontend source |
| `gui-dist/` | Built frontend — gitignored, generated by `npm run build:gui` |
| `nodemon.json` | Nodemon config for `npm run dev` |
| `package.json` | Root package — `commander`, `express`, `music-metadata`; dev: `concurrently`, `nodemon` |
| `.audiobooksignore.example` | Template ignore file — copy to your Audiobooks root |
| `CLAUDE.md` | Technical reference for AI-assisted development |
| `plan.json` | Generated at runtime — gitignored |
| `execute.log` | Generated at runtime — gitignored |
| `<root>/REORGANIZATION_GLOSSARY.md` | Human-readable dry-run report — generated in library root |
