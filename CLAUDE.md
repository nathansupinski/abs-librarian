# abs-librarian — Developer Reference

This file is the technical reference for AI-assisted development on this project. It documents non-obvious architecture decisions, edge cases, and invariants that aren't evident from reading the code.

## What This Tool Does

Reorganizes an Audiobookshelf library from ad-hoc structures to the expected `Author/[Series/]Title/audiofiles` convention. Runs dry-run first (generates a human-reviewable plan), then execute. Never deletes real audio files.

## Architecture Overview

Modular Node.js ESM project. Thin entry-point wrappers delegate to `src/`:

- `reorganize.mjs` → `src/cli.mjs` → `src/core/scanner.mjs` | `src/core/executor.mjs`
- `gui.mjs` → `src/gui-server.mjs` (Express API + SSE process runner)

Two top-level modes controlled by `--execute`:
- **Dry-run**: three-pass scan → builds in-memory plan state → writes `plan.json` + `REORGANIZATION_GLOSSARY.md`
- **Execute**: reads `plan.json`, processes each item, writes status back after every item (for restartability)

### Path Resolution (`src/cli.mjs`)

```javascript
const scriptDir  = path.dirname(new URL(import.meta.url).pathname); // src/
const planFile   = path.join(scriptDir, '..', 'plan.json');         // project root
const executeLog = path.join(scriptDir, '..', 'execute.log');       // project root
const glossary   = path.join(root, 'REORGANIZATION_GLOSSARY.md');   // library root
const ignoreFile = opts.ignoreFile ?? path.join(root, '.audiobooksignore');
```

`plan.json` and `execute.log` live next to the project root, not in the library.

### Three-Pass Scan (`src/core/scanner.mjs`)

`runDryScan(root, { planFile, glossaryPath, ignoreFile })` runs three passes:

1. **Pass 1 — Root files**: classifies each file at the library root. Audio files → ID3 tags + OpenLibrary fallback. Junk/system → junk DELETE.
2. **Pass 2 — Top-level dirs**: for each directory: hard-skip check → ignore rule check → special handlers (Lee Child, Marion Chesney) → generic author dir processing. Author dirs are recursively scanned for loose audio (needs book subfolder) and junk.
3. **Pass 3 — Empty dirs**: `scanForEmptyDirs(root)` walks the full tree looking for dirs not already in the plan that have no audio → junk DELETE.

All scan helper functions are closures inside `runDryScan`, sharing the `planState` object returned by `createPlanState()`. This keeps state local to each invocation — no module-level shared state.

### Plan Item Shape

```javascript
{
  id,               // auto-generated: type prefix + index, e.g. "M0", "D5"
  type: 'MOVE_DIR' | 'MOVE_FILE',
  source,           // absolute path
  dest,             // absolute path (null for junk delete)
  reason, notes,
  status: 'pending' | 'approved' | 'done' | 'skipped' | 'failed',
  error,            // populated on failure
  junk: bool,
  action: 'move' | 'delete',
  bestGuess: bool,
  fallbackDest,     // _NeedsReview/ path when bestGuess && !AUTO_ACCEPT_REVIEW
  bestGuessNote,
}
```

`approved` means the user explicitly confirmed this item in the GUI. Execute processes both `pending` and `approved`. `plan.json` is written atomically after every single item during execute — safe to interrupt and restart.

### Duplicate Record Shape

```javascript
{
  f1, f2,           // absolute paths
  note,             // reason string
  f1Meta, f2Meta,   // { artist, album, title, year, bitrate, duration, codec, size }
  recommendation,   // 'f1' | 'f2' | null — set at scan time
  resolution,       // { keep, deleteFile, resolvedAt } — set by GUI
}
```

When the user resolves a duplicate in the GUI, a synthesized `DUP${index}` DELETE item is added to `plan.items`. Running `--execute --delete-junk` processes it.

### HARD_SKIP

Dirs always skipped regardless of ignore file (exported from `src/core/constants.mjs`):
```javascript
const HARD_SKIP = new Set(['_NeedsReview', '_non-audiobook', '.claude'])
```

---

## Module Reference

### `src/core/constants.mjs`

Exports: `HARD_SKIP` (Set), `NON_AUDIOBOOK_DIRS` (Set), `AUDIO_EXTS` (Set), `JUNK_EXTS` (Set), `SYSTEM_NAMES` (Set), `KNOWN_MISPLACED` (Map).

### `src/core/fs-utils.mjs`

Exports: `listDir`, `statOf`, `isAudio`, `isSystemFile`, `isJunkFile`, `hasAudioRecursive`, `isDoubleNested`, `copyTree`, `verifyTree`, `removeTree`, `safeMove`, `deleteItem`, `cleanEmptyShells`.

**`isSystemFile(name)`**
Returns true for `SYSTEM_NAMES` set members **or** `name.startsWith('._')`. The `._` prefix is the Mac AppleDouble resource fork convention — these files are always junk regardless of extension (e.g., `._foo.mp3` is not audio).

**`safeMove(src, dest, root)`**
Three cases:
1. **Parent→child** (`dest.startsWith(src + '/')`): Linux `rename()` returns EINVAL. Fix: shuffle via sibling temp — `renameSync(src, src+'__reorg_tmp')`, `mkdirSync(src)`, `renameSync(tmp, dest)`. Restores tmp→src on error.
2. **Same filesystem**: `renameSync` (atomic).
3. **Cross-filesystem** (EXDEV, common on Unraid shfs union): `copyTree` + `verifyTree` (byte-size comparison per file) + `removeTree`.

**`deleteItem(p, root, forceDeleteAudioJunk)`**
Safety checks in order:
1. Path must be inside `root` — hard throw otherwise.
2. `._*` prefix → skip audio check (resource fork, never real audio regardless of extension).
3. `isAudio(basename)` → throw unless `forceDeleteAudioJunk` set.

**`cleanEmptyShells(dir, depth, { root, executeLog, hardSkip })`**
Post-execute cleanup (only with `--delete-empty-shells`). Walks bottom-up. Removes a dir if it has no audio and all remaining files are system/junk/hidden. Never removes ROOT (depth 0 guard).

### `src/core/ignore.mjs`

**`loadIgnoreFile(filePath)`** → returns array of rule strings (or `[]` if file missing).

**`matchedIgnoreRule(relPath, isDir, rules)`**
Rules are passed as a parameter — not a module-level global. Rules:
- Trailing `/`: dirs only
- No `/` in pattern: match any path component at any depth
- `/` in pattern: match full relative path from ROOT
- Returns matching rule string or `null`

**Important**: ignore rules are checked before ANY other classification. They always win over system/junk detection.

### `src/core/metadata.mjs`

**`readTags(filePath, full = false)`**
- `full = false` (scan time): returns `{ artist, album }`
- `full = true` (duplicate comparison): returns `{ artist, album, title, year, bitrate (kbps, rounded), duration (seconds, rounded), codec }`

Uses `music-metadata` v11 (ESM-only). Always returns a safe object with null fields on parse failure.

**`recommendDuplicate(m1, m2, stat1, stat2)`** → `'f1' | 'f2' | null`
Preference order: higher bitrate → more complete ID3 tag count → larger file size.

**`searchOpenLibrary(title)`** → `{ found, docs, ambiguous, error? }`
Hits `https://openlibrary.org/search.json?title=...&fields=title,author_name&limit=3` with a 12s timeout.

### `src/core/plan.mjs`

**`createPlanState()`** — factory that returns isolated mutable state + helpers. Called once per `runDryScan` invocation; never shared between calls.

Returns: `{ planItems, lookupLog, duplicates, skipLog, addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip, addDuplicate, addLookup }`.

`addDuplicate(f1, f2, note, meta = {})` — `meta` is spread in; pass `{ f1Meta, f2Meta, recommendation }` from the scanner.

**`writePlan(planFile, plan)`** — atomic: writes to `.tmp` then renames.

**`buildPlanOutput({ planItems, lookupLog, duplicates, skipLog, ignoreFile })`** — assembles the final JSON structure.

**`writeGlossary(glossaryPath, ...)`** — writes `REORGANIZATION_GLOSSARY.md` to the library root.

### `src/core/executor.mjs`

**`runExecute(planFile, executeLog, root, options)`**

Execute filter — processes pending, approved, and optionally failed items:
```javascript
const toProcess = plan.items.filter(i =>
  i.status === 'pending' || i.status === 'approved' ||
  (retryFailed && i.status === 'failed'));
```

Writes `writePlan` after every item for restartability.

### `src/gui-server.mjs`

Express 5 API server. Important: uses `app.get('/{*splat}', ...)` for the SPA fallback — Express 5 / path-to-regexp v8 requires named wildcards, not bare `*`.

**Process runner state (module-level singleton):**
```javascript
let currentRun = null; // { process, type, output: string[] }
const sseClients = new Set();
```

SSE endpoint `/api/run/stream` replays buffered output for new connections (catch-up). Events: `start`, `output`, `done`, `status`.

**Allowed PATCH fields for items:** `status` (pending/approved/skipped only), `dest`, `bestGuess`, `fallbackDest`. `done` and `failed` are read-only; the GUI cannot set them.

**Duplicate resolution (`PATCH /api/duplicates/:index`):**
1. Adds `resolution: { keep, deleteFile, resolvedAt }` to the duplicate record.
2. Synthesizes a DELETE item with id `DUP${index}` in `plan.items`.

**`/api/fs/ls?path=...`** — directory listing for the path picker. Scoped to ROOT (derived from `plan.ignoreFile` parent directory); returns 403 for paths outside it.

---

## GUI Architecture (`gui/`)

Vite 6 + React 19 + Tailwind CSS v4. Separate package with its own `node_modules`. Built output goes to `../gui-dist/` (project root level) which the Express server serves statically.

**Tailwind v4 setup:** `gui/src/index.css` contains only `@import "tailwindcss"`. No `tailwind.config.js` needed.

**Dev proxy:** `vite.config.js` proxies `/api` → `http://localhost:7000`. Open `http://localhost:5173` for hot-reload dev.

**`gui/src/hooks/usePlan.js`** — React Query v5 hooks. All mutations invalidate `['plan']` on success so the UI stays fresh. `useDupMeta(index, enabled)` is lazy — only fetches when `enabled=true` (user clicks Load Metadata).

**`gui/src/components/ItemRow.jsx`** — `PathDisplay` component uses `direction: rtl` on the directory portion so long paths truncate from the left, keeping the filename always visible. Row click toggles an expanded detail panel showing full absolute source and destination paths.

**`gui/src/components/PlanSection.jsx`** — Groups items by first 2 path segments relative to ROOT. Each group has per-group Approve All / Skip All. Section header has global Approve All / Skip All.

**`gui/src/components/DuplicateCard.jsx`** — Side-by-side metadata comparison. Better value per row is highlighted; recommended column gets a ★. Falls back to `/api/duplicate-meta/:index` for old plan.json files missing `f1Meta`/`f2Meta`.

**`gui/src/components/RunControls.jsx`** — SSE subscription via `EventSource('/api/run/stream')`. Terminal log auto-scrolls. Execute flags panel (5 flags). Active flag count shown as badge on Options button.

---

## Special Case Handlers

### Lee Child / Jack Reacher
- `isDoubleNested(bookPath)` (in `src/core/fs-utils.mjs`): true when the only real subdir has the same name as the parent and there's no audio at the top level.
- Double-nested: moves inner dir to `Lee Child/Jack Reacher/NN - Title/`; outer shell becomes empty and is cleaned by `--delete-empty-shells`.
- `parseLeeChildFolder(name)`: regex for `Lee.Child.-.Jack.Reacher.NN.-.Title` pattern.

### Marion Chesney (Agatha Raisin + Hamish Macbeth)
- `parseAgathaRaisinFolder`: matches `Agatha Raisin NN - Title`.
- `parseMCBeatonFolder`: matches `M C Beaton - AR##/HM## Title [XofY]` — extracts series code, book number, title, disc number.
- Partial disc folders (XofY pattern) → `bestGuess` items pointing to `Series/NN - Title/Disc N/`.
- `extractDiscInfo(name)`: extracts any `XofY` pattern.

### Root-Level MP3s + Unknown Top-Level Book Dirs
Both use the same resolution pipeline:
1. Read ID3 tags via `music-metadata`: `common.artist`/`common.albumartist` = author, `common.album` = title.
2. No author → `searchOpenLibrary(title)` hits OpenLibrary API.
3. Single unambiguous result → move to `Author/Title/`.
4. Multiple different authors → `bestGuess` item → `_NeedsReview/` without `--auto-accept-review`.

### Parent→Child EINVAL Case
When `classifyUnknownTopLevelBook` identifies a dir as a single-book folder and the found author matches the dir name (e.g., dir `Aasif Mandvi/` with ID3 artist="Aasif Mandvi", album="Sakina's Restaurant"), the plan item becomes `MOVE_DIR` with dest inside src. The `safeMove` parent→child shuffle in `src/core/fs-utils.mjs` handles this.

---

## Execute Log Format

Appended to `execute.log` per run:
```
========================================================================
=== EXECUTE RUN: <ISO timestamp> ===
Flags: --execute [flags...]
Items: N pending[, M retrying]
========================================================================
DONE   renamed  Author → Author/Book Title
DONE   deleted  path/to/._foo.mp3
SKIP   exists   path/to/already-there
FAIL   move     path/to/item: error message
--- SUMMARY: N done, N skipped, N failed ---
```

---

## Known Hardcoded Author Mappings (`KNOWN_MISPLACED`)

`KNOWN_MISPLACED` in `src/core/constants.mjs` handles top-level folders that are book/series titles rather than author names:
- `A Column of Fire` → Ken Follett / Kingsbridge
- `Dark Eden-A Novel` → Chris Beckett
- `The Golden Compass` → Philip Pullman / His Dark Materials
- `Information Doesnt Want to Be Free Audiobook` → Cory Doctorow
- `Hank the Cowdog books 01-05` → John R. Erickson / Hank the Cowdog
- `Michael.Watkins.-.The.First.90.Days` → Michael Watkins

Add entries here for any other misplaced top-level folders discovered in the library.

---

## Adding Support for a New Author's Naming Convention

1. Write a `parseXxxFolder(name)` function as a closure inside `runDryScan` in `src/core/scanner.mjs` that returns structured data or null.
2. Add a condition in `processBookDir` (or `processAuthorDir`) to call it.
3. Use `addMove` for confident placements, `addBestGuess` when uncertain.
4. Call `scanBookForJunk` on the source path to catch junk files inside it.
5. Call `addLookup` to log the resolution in the glossary.

---

## Unraid-Specific Notes (where this was originally built)

- Library at `/mnt/user/Audiobooks` on Unraid 7.2.2 running as root.
- `/mnt/user/` is shfs (union filesystem over multiple physical disks). Files in the same share can be on different physical disks, so `rename()` may return EXDEV — handled in `safeMove`.
- Never use `/mnt/disk*/` paths directly — always go through `/mnt/user/` to stay on the union layer.
- `music-metadata` v11 is ESM-only, which is why all files use `.mjs` with `import` syntax.
