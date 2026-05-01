# abs-librarian — Developer Reference

Technical reference for AI-assisted development. Documents non-obvious architecture decisions, edge cases, and invariants not evident from reading the code.

## What This Tool Does

Reorganizes an Audiobookshelf library from ad-hoc structures to `Author/[Series/]Title/audiofiles`. Runs dry-run first (generates a human-reviewable plan), then execute. Never deletes real audio files.

## Architecture Overview

Modular Node.js ESM project. Thin entry-point wrappers delegate to `src/`:

- `reorganize.mjs` → `src/cli.mjs` → `src/core/scanner.mjs` | `src/core/executor.mjs`
- `gui.mjs` → `src/gui-server.mjs` (Express API + SSE process runner)

Two top-level modes controlled by `--execute`:
- **Dry-run**: three-pass scan → rules engine → builds in-memory plan state → writes `plan.json` + `REORGANIZATION_GLOSSARY.md`
- **Execute**: reads `plan.json`, processes each item, writes status back after every item (for restartability)

### Path Resolution (`src/cli.mjs`)

```javascript
const planFile   = path.join(scriptDir, '..', 'plan.json');         // project root
const executeLog = path.join(scriptDir, '..', 'execute.log');       // project root
const glossary   = path.join(root, 'REORGANIZATION_GLOSSARY.md');   // library root
const ignoreFile = opts.ignoreFile ?? path.join(root, '.audiobooksignore');
```

### Three-Pass Scan (`src/core/scanner.mjs`)

`runDryScan` loads rules from `src/rules/` at startup, then runs three passes:

1. **Pass 1 — Root files**: classifies each file at the library root. Audio → ID3 tags + OpenLibrary fallback. Junk/system → DELETE.
2. **Pass 2 — Top-level dirs**: hard-skip → ignore rules → `user-mappings.json` check → audio-at-root check → `processAuthorDir`.
3. **Pass 3 — Empty dirs**: `scanForEmptyDirs` walks the full tree, marks dirs with no audio → DELETE.

All classifier functions are closures inside `runDryScan` sharing `planState` from `createPlanState()`. A `RuleContext` object (built once per scan) is passed to every rule hook — rules never import scanner internals directly.

### Plan Item Shape

```javascript
{
  id,               // auto-generated: type prefix + index, e.g. "M0", "D5"
  type: 'MOVE_DIR' | 'MOVE_FILE',
  source, dest,     // absolute paths (dest null for junk delete)
  reason, notes,
  status: 'pending' | 'approved' | 'done' | 'skipped' | 'failed',
  junk: bool, action: 'move' | 'delete', bestGuess: bool,
  fallbackDest,     // _NeedsReview/ path when bestGuess && !AUTO_ACCEPT_REVIEW
  bestGuessNote, error,
}
```

`plan.json` is written atomically after every single item during execute — safe to interrupt and restart.

### Duplicate Record Shape

```javascript
// Pairwise duplicate (two files, same content)
{ f1, f2, note, f1Meta, f2Meta, recommendation, resolution }

// Group duplicate (combined file vs. chapter collection)
{
  groupA: { files: string[], totalSize: number, description: string },
  groupB: { files: string[], totalSize: number, description: string },
  note, groupALabel, groupBLabel, recommendation, resolution,
}
```

Resolving a pairwise duplicate synthesizes a `DUP${index}` plan item. Resolving a group duplicate synthesizes `GD${index}_${fileIndex}` items for all files in the discarded group. Whether each item is a DELETE (`junk: true, action: 'delete', dest: null`) or a MOVE (`junk: false, action: 'move', dest: <duplicatesFolder>/...`) depends on `plan.settings.duplicatesFolder` at resolution time.

### HARD_SKIP

```javascript
const HARD_SKIP = new Set(['_NeedsReview', '_non-audiobook', '.claude'])
```

---

## Rules System (`src/rules/`)

Rules are auto-loaded at scan start. Any `.mjs` file with a default export extending `ScanRule` is automatically included — no registration needed.

### Base Class (`src/rules/BaseRule.mjs`)

```javascript
export class ScanRule {
  get name()     { return this.constructor.name; }
  get priority() { return 100; }  // lower = runs first

  // Return true to claim the directory (stops chain). Return false to pass.
  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) { return false; }
  async onAuthorDir(authorPath, authorName, ctx)                   { return false; }
}
```

### RuleContext

Passed to every hook. Contains: `addMove`, `addJunkMove`, `addJunkDelete`, `addBestGuess`, `addSkip`, `addDuplicate`, `addGroupDuplicate`, `addLookup` (plan mutators); `root`, `relPath`, `checkIgnore`; `listDir`, `statOf`, `isAudio`, `isSystemFile`, `isJunkFile`, `hasAudioRecursive`, `isDoubleNested`; `readTags`, `recommendDuplicate`, `searchOpenLibrary`; `scanBookForJunk`.

### Built-in Rules (priority order)

| File | Priority | Pattern matched |
|------|----------|-----------------|
| `dot-separated-format.mjs` | 10 | `A.B.-.Series.NN.-.Title` — any author using dot-separated naming |
| `series-code-format.mjs` | 20 | `M C Beaton - AR##/HM## Title [NofM]` + `Agatha Raisin NN - Title` |
| `combined-chapters-duplicate.mjs` | 25 | One large combined file + many chapter files in same folder |
| `mismatched-files-in-folder.mjs` | 30 | Audio files whose ID3 album tags don't match the container folder |

### Adding a New Rule

1. Create `src/rules/my-rule.mjs` with a default export extending `ScanRule`.
2. Override `onBookDir` and/or `onAuthorDir`; return `true` if handled.
3. Use `ctx.scanBookForJunk(bookPath, bookName, authorName, recursive)` before returning `true` to catch junk inside the directory.
4. Call `ctx.addLookup({ filename, method, result, confidence, notes })` for audit trail.
5. The loader picks it up automatically on next scan.

---

## Module Reference

### `src/core/constants.mjs`

Exports: `HARD_SKIP`, `NON_AUDIOBOOK_DIRS`, `AUDIO_EXTS`, `JUNK_EXTS`, `SYSTEM_NAMES`. `KNOWN_MISPLACED` has been removed — use `user-mappings.json` instead.

### `src/core/fs-utils.mjs`

**`isSystemFile(name)`** — true for `SYSTEM_NAMES` members or `name.startsWith('._')`. The `._` prefix is Mac AppleDouble; always junk regardless of extension.

**`safeMove(src, dest, root)`** — three cases: parent→child (EINVAL shuffle via sibling temp), same filesystem (atomic rename), cross-filesystem (EXDEV: copyTree + verifyTree + removeTree).

**`deleteItem(p, root, forceDeleteAudioJunk)`** — safety checks: must be inside root, `._*` bypasses audio check, audio extension throws unless `forceDeleteAudioJunk` set.

### `src/core/metadata.mjs`

**`readTags(filePath, full = false)`** — `full=false`: `{ artist, album }`. `full=true`: adds `title, year, bitrate (kbps), duration (secs), codec`. Uses `music-metadata` v11 (ESM-only). Safe on parse failure.

**`recommendDuplicate(m1, m2, stat1, stat2)`** → `'f1' | 'f2' | null`. Preference: higher bitrate → more ID3 tags → larger file.

**`searchOpenLibrary(title)`** → `{ found, docs, ambiguous, error? }`. 12s timeout. `ambiguous` = top 2 results have different authors.

### `src/core/plan.mjs`

**`createPlanState()`** — returns isolated mutable state + helpers. Returns: `{ planItems, lookupLog, duplicates, groupDuplicates, skipLog, addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip, addDuplicate, addGroupDuplicate, addLookup }`.

**`addGroupDuplicate(groupA, groupB, note, opts)`** — each group: `{ files, totalSize, description }`. Resolution synthesized by `gui-server.mjs`.

**`buildPlanOutput({ ..., settings })`** — includes `settings` (e.g. `{ duplicatesFolder }`) in the written plan. Scanner passes it through from CLI options or leaves it `{}`.

**`writePlan(planFile, plan)`** — atomic write via `.tmp` + rename.

### `src/core/user-mappings.mjs`

**`loadUserMappings()`** — reads `user-mappings.json` from project root, returns `{}` on missing file. Scanner uses `userMappings.knownMisplaced[dirName]` in pass 2 to handle top-level folders named after books rather than authors.

`user-mappings.json` shape: `{ "knownMisplaced": { "Folder Name": { author, series, title, confidence, note } } }`

### `src/core/executor.mjs`

Processes `pending`, `approved`, and optionally `failed` items. Writes `writePlan` after every item. Synthesized `DUP*` and `GD*` items are processed as follows:
- `action: 'delete'` (`junk: true`) — deleted only when `--delete-junk` is passed
- `action: 'move'` (`junk: false`) — moved to `dest` automatically without any extra flag

### `src/gui-server.mjs`

Express 5. SPA fallback uses `/{*splat}` (named wildcard — Express 5 / path-to-regexp v8 requirement).

Key endpoints: `PATCH /api/settings` (updates `plan.settings`; currently only `duplicatesFolder`), `PATCH /api/duplicates/:index` (synthesizes `DUP${idx}`), `PATCH /api/group-duplicates/:index` (synthesizes `GD${idx}_*`), `DELETE /api/*/resolution` (removes synthesized items + clears resolution), `/api/fs/ls` (scoped to ROOT).

Duplicate resolution synthesis: if `plan.settings.duplicatesFolder` is set, the synthesized item uses `action: 'move'` with `dest = path.join(duplicatesFolder, path.relative(ROOT, discardFile))` and `junk: false`. Otherwise `action: 'delete'`, `dest: null`, `junk: true`.

Allowed PATCH fields for items: `status` (pending/approved/skipped only), `dest`, `bestGuess`, `fallbackDest`. `done` and `failed` are read-only.

---

## GUI Architecture (`gui/`)

Vite 6 + React 19 + Tailwind CSS v4. Separate package with its own `node_modules`. Built output → `../gui-dist/`. Dev proxy: `/api` → `http://localhost:7000`.

**`DuplicateCard.jsx`** — side-by-side comparison; falls back to `/api/duplicate-meta/:index` for plans missing `f1Meta`/`f2Meta`. Accepts `duplicatesFolder` prop; shows "Will move to…" vs "Will delete:" in the resolved state and updates button tooltips accordingly.

**`GroupDuplicateCard.jsx`** — combined file vs. chapters comparison. Expandable file list for the chapter side. Resolution adds items via `PATCH /api/group-duplicates/:index`. Accepts `duplicatesFolder` prop for the same move/delete labelling.

**`PlanSection.jsx`** — groups items by first 2 path segments relative to ROOT. Per-group and global Approve All / Skip All.

**`RunControls.jsx`** — SSE via `EventSource('/api/run/stream')`; replays buffered output for new connections. Options panel includes a "Duplicates folder" text input that saves to `plan.settings` via `PATCH /api/settings`; blank = delete mode.

---

## Execute Log Format

```
=== EXECUTE RUN: <ISO timestamp> ===
Flags: --execute [flags...]
DONE   renamed  Author → Author/Book Title
SKIP   exists   path/to/already-there
FAIL   move     path/to/item: error message
--- SUMMARY: N done, N skipped, N failed ---
```

---

## Unraid-Specific Notes

- Library at `/mnt/user/Audiobooks` on Unraid shfs (union filesystem). Files in the same share may be on different physical disks → `rename()` can return EXDEV, handled in `safeMove`.
- Never use `/mnt/disk*/` paths — always go through `/mnt/user/`.
- `music-metadata` v11 is ESM-only → all files use `.mjs`.
