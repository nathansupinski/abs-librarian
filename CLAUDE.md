# abs-librarian — Developer Reference

Technical reference for AI-assisted development. Documents non-obvious architecture decisions, edge cases, and invariants not evident from reading the code.

## What This Tool Does

Reorganizes an Audiobookshelf library from ad-hoc structures to `Author/[Series/]Title/audiofiles`. Runs dry-run first (generates a human-reviewable plan), then execute. Never deletes real audio files.

## Architecture Overview

Modular Node.js ESM project. Thin entry-point wrappers delegate to `src/`:

- `reorganize.mjs` → `src/cli.mjs` → `src/core/scanner.mjs` | `src/core/executor.mjs`
- `gui.mjs` → `src/gui-server.mjs` (Express API + SSE process runner)

Three top-level modes:
- **Dry-run** (default): three-pass scan of `--root` → rules engine → builds in-memory plan state → writes `plan.json` + `REORGANIZATION_GLOSSARY.md`
- **Ingest dry-run** (`--ingest <path>`): scans the ingest folder as the source, plans moves into `--root` (the library); detects books that already exist in the library and surfaces them as **conflicts** instead of moves
- **Execute** (`--execute`): reads `plan.json`, processes each item, writes status back after every item (for restartability)

### Path Resolution (`src/cli.mjs`)

```javascript
const planFile   = path.join(scriptDir, '..', 'plan.json');         // project root
const executeLog = path.join(scriptDir, '..', 'execute.log');       // project root
const glossary   = path.join(root, 'REORGANIZATION_GLOSSARY.md');   // library root
const ignoreFile = opts.ignoreFile ?? path.join(root, '.audiobooksignore');
```

### Three-Pass Scan (`src/core/scanner.mjs`)

`runDryScan(root, { destRoot, ... })` loads rules from `src/rules/` at startup, then runs three passes:

1. **Pass 1 — Root files**: classifies each file at the scan root. Audio → ID3 tags + metadata provider cascade fallback. Junk/system → DELETE.
2. **Pass 2 — Top-level dirs**: hard-skip → ignore rules → `user-mappings.json` check → audio-at-root check → `processAuthorDir`.
3. **Pass 3 — Empty dirs**: `scanForEmptyDirs` walks the full tree, marks dirs with no audio → DELETE. **Skipped in ingest mode** — an emptied ingest folder is the desired state, not junk-cleanup material.

All classifier functions are closures inside `runDryScan` sharing `planState` from `createPlanState()`. A `RuleContext` object (built once per scan) is passed to every rule hook — rules never import scanner internals directly.

### Source vs. Destination Root

`runDryScan(root, opts)` accepts an optional `opts.destRoot` (defaults to `root`). The scanner walks `root` (the scan source) but constructs destinations under `destRoot` (the library). In normal mode the two are identical and behavior is byte-identical with prior versions. In ingest mode they differ:
- `root` = ingestion folder (scanned for new books)
- `destRoot` = existing library (target of moves)

`ctx.destPath(...segments)` is `path.join(destRoot, ...segments)` — rules use it instead of `path.join(authorPath, ...)` for destinations. The `authorPath` parameter passed to rule hooks is still the source author path (used for reading source contents); only destination construction goes through `destPath`.

### Ingest Mode (`destRoot !== root`)

Triggered by `--ingest <path>` on the CLI (or `POST /api/run/ingest` in the GUI). On scan start:

1. **Library index build** (`src/core/library-index.mjs`): BFS the library, sample one audio file per audio-bearing leaf directory, build `{ byPath: Set, byContent: Map<"artist|album", [dir, ...]> }` with concurrency-8 reads. Status logged: `[ingest] Indexed N unique books in M.Ms`.
2. **Source-meta recording**: classifier helpers and rules call `ctx.recordSourceMeta(sourcePath, { artist, album })` whenever they read ID3 tags. The map is consulted synchronously by the conflict-check wrapper.
3. **addMove/addBestGuess wrapper**: replaces the plan-state mutators. Each call runs `ctx.checkConflict(source, dest)`:
   - `statOf(dest)` exists → `{ matchType: 'path', libraryFile: dest }`
   - Source meta matches `libraryIndex.byContent` → `{ matchType: 'content', libraryFile: hits[0] }`
   - Otherwise → null, and the move proceeds normally.

   When a conflict is detected, the wrapper diverts the call to `addConflict(...)` and **the move is suppressed**. The user must resolve in the GUI before the move appears in `items`.
4. **Plan settings**: `plan.settings.sourceRoot` and `plan.settings.destRoot` are persisted so the executor and GUI know both roots even on later invocations.

The library index is in-memory only (not cached to disk); rebuilt every scan.

### Conflict Resolution

A conflict has three possible resolutions, all PATCHed via `/api/conflicts/:index` with `{ keep: 'new' | 'existing' | 'dismiss' }`:

- **`new`** — replace the library copy with the ingested one. Synthesizes two items: `CF${idx}_evict` (sideline existing library file; move to `plan.settings.duplicatesFolder` if set, else delete with `junk:true`) and `CF${idx}_move` (ingested → dest).
- **`existing`** — keep the library copy. No synthesized items; ingestion source stays where it is (no SKIP item; absence-of-move IS the skip).
- **`dismiss`** — false positive. Synthesizes the original `CF${idx}_move` as if no conflict existed.

`DELETE /api/conflicts/:index/resolution` clears any prior resolution and removes all `CF${idx}_*` items.

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
  providerMatch,    // optional — set when a metadata provider confirmed the move
}
```

`providerMatch` shape (present only when a provider was used):
```javascript
{
  provider: string,       // e.g. 'Audible', 'OpenLibrary', 'GoogleBooks'
  title: string,
  author: string | null,
  series: [{ series: string, sequence: string | null }],
  narrator: string | null,
  publishedYear: string | null,
  asin: string | null,
  confidence: number,     // 0–1
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

A duplicate can also be **dismissed** as a false positive (`dup.dismissed = true` / `gd.dismissed = true`). Dismissal clears any prior resolution + synthesized items and produces no plan items — both files stay in place. The `DELETE /api/{duplicates,group-duplicates}/:index/resolution` endpoint clears both `resolution` and `dismissed`.

### Conflict Record Shape (ingest mode)

```javascript
{
  source,             // absolute path in ingestion folder
  dest,               // absolute path in library (where the move would have gone)
  libraryFile,        // absolute path of the existing library item (file or dir)
  matchType: 'path' | 'content',
  intendedReason,     // reason the suppressed move would have had
  intendedNotes,
  sourceMeta,         // { artist, album, title, year, bitrate, duration, codec, size } | null
  libraryMeta,        // same shape | null — populated lazily by GET /api/conflict-meta/:index
  recommendation: 'new' | 'existing' | null,
  resolution,         // { keep: 'new'|'existing', resolvedAt } | null
  dismissed: bool,    // true when user marked false-positive
}
```

Resolving a conflict synthesizes plan items prefixed `CF${idx}_` (`_evict` and/or `_move`). Dismissing synthesizes only the `_move` item. The conflict object stays in `plan.conflicts` for audit; the items list drives execute.

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

Passed to every hook. Contains:
- **Plan mutators**: `addMove`, `addJunkMove`, `addJunkDelete`, `addBestGuess`, `addSkip`, `addDuplicate`, `addGroupDuplicate`, `addLookup`. In ingest mode, `addMove` and `addBestGuess` are wrapped to divert path/content collisions to the conflicts list.
- **Roots**: `root` (scan source — what to walk), `destRoot` (library — where destinations live; equals `root` in normal mode), `destPath(...segs)` = `path.join(destRoot, ...segs)`. **Rules must use `ctx.destPath(authorName, …)` for destination construction**, never `path.join(authorPath, …)` — `authorPath` is the source-side directory and only equals the destination author dir in normal mode.
- **Ingest helpers**: `recordSourceMeta(path, { artist, album })` — records ID3 metadata for the synchronous conflict check. Rules that read tags should call this so content-match conflicts trigger correctly.
- **Filesystem helpers**: `relPath`, `checkIgnore`, `listDir`, `statOf`, `isAudio`, `isSystemFile`, `isJunkFile`, `hasAudioRecursive`, `isDoubleNested`.
- **Metadata helpers**: `readTags`, `recommendDuplicate`, `searchOpenLibrary` (legacy), `resolveMetadata({ title, author, duration })` → `ResolverResult | null`.
- **Misc**: `scanBookForJunk`, `currentSeries`, `seriesContainers`.

### Built-in Rules (priority order)

| File | Priority | Pattern matched |
|------|----------|-----------------|
| `dot-separated-format.mjs` | 10 | `A.B.-.Series.NN.-.Title` — any author using dot-separated naming |
| `series-code-format.mjs` | 20 | `M C Beaton - AR##/HM## Title [NofM]` + `Agatha Raisin NN - Title` |
| `combined-chapters-duplicate.mjs` | 25 | One large combined file + many chapter files in same folder |
| `series-detection.mjs` | 27 | Embedded series in folder names + author-level provider lookup |
| `nested-series-container.mjs` | 29 | Container dir with a "mixed leaf" — one folder directly holding audio from 2+ distinct albums |
| `mismatched-files-in-folder.mjs` | 30 | Audio files whose ID3 album tags don't match the container folder |

#### `series-detection.mjs` — author-scoped strategies

In `onAuthorDir` it processes all books in the author directory in four passes,
sharing a per-author `knownSeries` set across passes:

1. **Embedded** — folder names matching `Title [-_:] Series, Book N` are
   grouped; one provider call canonicalises the series name per group.
2. **Numbered prefix** — 2+ siblings sharing `Series N - Title` (with a
   stop-list of generic prefixes like `Book`/`Vol`/`Part`).
3. **Provider lookup** — every still-unmatched book gets a single
   `resolveMetadata` call. The picker prefers series with a sequence over
   meta-series (so e.g. Stormlight Archive #1 beats The Cosmere #?), and
   prefers entries already in `knownSeries` for this author. **Guard:** if the
   folder name matches the returned series name (after stripping a leading
   "The"), the folder is a series container — it is skipped here and left for
   `nested-series-container.mjs` to handle.
4. **Substring fallback** — for books still unmatched, if the folder name
   contains a series name from `knownSeries`, claim it (low confidence,
   no sequence). Catches specials/audio dramas providers don't index.

Results are cached on the rule instance and surfaced in `onBookDir`. Set
`ABS_DEBUG_SERIES=1` (or `--debug-rules`) to log per-decision output.

#### `nested-series-container.mjs` — mixed-leaf extraction

Runs in `onBookDir` and targets one narrow pattern: a directory with **no audio
at its own root level** that contains, somewhere underneath, a **mixed leaf** —
a single directory directly holding audio files whose ID3 album tags span 2+
distinct titles (e.g. Harry Potter/03 - .../02 - .../[7 different books].mp3).

Algorithm:
1. Walk every audio-bearing directory under the book dir; record its files +
   ID3 tags.
2. Filter to "mixed leaves": directories whose **own** audio files span 2+
   distinct albums. If none, return false.
3. Group all files in mixed leaves by album tag.
4. For each group, call `resolveMetadata({ title, author, duration,
   preferredSeries: [bookName] })` to get a series sequence number (best-effort,
   confidence ≥ 0.55).
5. Emit `MOVE_FILE` items to `Author/Container/[Seq - ]AlbumTitle/filename`.
6. Files with no album tag → `addBestGuess` to `_NeedsReview/`.

Two design choices keep the rule narrow:
- **Mixed-leaf trigger**: pure leaves (each subfolder = one book's chapters)
  never trigger the rule, regardless of whether folder names exactly match
  album tags. This rule does not renumber or rename per-book subfolders —
  that is outside its scope.
- **Album tag = destination name**: the ID3 album tag is the ground truth for
  the folder name, not the (potentially wrong) parent directory name. Prevents
  wrongly-named folders like `*(Full-Cast Edition)*` from polluting the output.

Defense-in-depth: any plan item whose computed destination equals its source
is dropped before emission.

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

**`safeMove(src, dest, root)`** — three cases: parent→child (EINVAL shuffle via sibling temp), same filesystem (atomic rename), cross-filesystem (EXDEV: copyTree + verifyTree + removeTree). `root` may be a string OR an array of allowed roots (ingest mode passes `[libraryRoot, sourceRoot]`).

**`deleteItem(p, root, forceDeleteAudioJunk)`** — safety checks: target must live underneath at least one allowed root, `._*` bypasses audio check, audio extension throws unless `forceDeleteAudioJunk` set. `root` accepts string or array.

**`removeTree(p, root)`** — same string-or-array convention; safety check is the same `withinRoots(p, root)` helper.

### `src/core/library-index.mjs`

**`buildLibraryIndex(destRoot, { concurrency = 8 })`** → `{ byPath: Set<string>, byContent: Map<"artist|album", string[]> }`.

Used only in ingest mode. BFS `destRoot` skipping `HARD_SKIP`, `NON_AUDIOBOOK_DIRS`, `_NeedsReview`, `_misc`, `_non-audiobook`, and dotfiles. For each audio-bearing leaf directory (one with audio files at its own root level), samples the first audio file (sorted by name) and reads its ID3 tags via `readTags(file, false)`. Keys are `${artist}|${album}` lowercased and trimmed; entries with both fields empty are dropped. Concurrency-bounded by a small inline semaphore. No on-disk caching for v1.

### `src/core/metadata.mjs`

**`readTags(filePath, full = false)`** — `full=false`: `{ artist, album }`. `full=true`: adds `title, year, bitrate (kbps), duration (secs), codec`. Uses `music-metadata` v11 (ESM-only). Safe on parse failure.

**`recommendDuplicate(m1, m2, stat1, stat2)`** → `'f1' | 'f2' | null`. Preference: higher bitrate → more ID3 tags → larger file.

**`searchOpenLibrary(title)`** → `{ found, docs, ambiguous, error? }`. 12s timeout. `ambiguous` = top 2 results have different authors.

### `src/core/plan.mjs`

**`createPlanState()`** — returns isolated mutable state + helpers. Returns: `{ planItems, lookupLog, duplicates, groupDuplicates, skipLog, addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip, addDuplicate, addGroupDuplicate, addLookup }`.

**`addMove(source, dest, reason, notes = '', opts = {})`** / **`addBestGuess(source, bestDest, fallbackDest, reason, bestGuessNote, opts = {})`** — `opts` is spread into the plan item, used to attach `{ providerMatch }` when a metadata provider confirmed the decision.

**`addGroupDuplicate(groupA, groupB, note, opts)`** — each group: `{ files, totalSize, description }`. Resolution synthesized by `gui-server.mjs`.

**`addConflict({ source, dest, reason, notes, matchType, libraryFile, sourceMeta?, libraryMeta?, recommendation? })`** — ingest-mode only. Used by the scanner wrapper around `addMove`/`addBestGuess` when a destination collides with the library. The original move is **suppressed**; user resolves in the GUI to synthesize the actual `CF*` items.

**`buildPlanOutput({ ..., settings })`** — includes `settings` and the new `conflicts` array. Settings keys: `duplicatesFolder` (always optional); `sourceRoot` + `destRoot` (ingest mode only — persist both roots so executor/GUI know the ingest mapping even on later invocations).

**`writePlan(planFile, plan)`** — atomic write via `.tmp` + rename.

### `src/core/user-mappings.mjs`

**`loadUserMappings()`** — reads `user-mappings.json` from project root, returns `{}` on missing file. Scanner uses `userMappings.knownMisplaced[dirName]` in pass 2 to handle top-level folders named after books rather than authors.

`user-mappings.json` shape: `{ "knownMisplaced": { "Folder Name": { author, series, title, confidence, note } } }`

### `src/providers/`

Metadata provider system. Auto-instantiated singleton (`resolver`) exported from `src/providers/index.mjs`.

**`BaseProvider`** — abstract base class. Subclasses implement `async search({ title, author, isbn, asin, duration })` → `ProviderResult[]`. Never throws; returns `[]` on failure. `ProviderResult` shape: `{ title, author, subtitle, narrator, publisher, publishedYear, description, isbn, asin, genres, language, duration (secs), series: [{ series, sequence }] }`.

**`AudibleProvider`** — `api.audible.com/1.0/catalog/products`. Flat response: `authors[].name`, `narrators[].name`, `series[].title/.sequence`, `runtime_length_min * 60 → duration`. No auth required.

**`OpenLibraryProvider`** — `openlibrary.org/search.json`. Refactors the legacy `searchOpenLibrary()` function. Returns `series: []`, `duration: null`.

**`GoogleBooksProvider`** — `googleapis.com/books/v1/volumes`. Free, no auth (1000 req/day unauthenticated). Returns `series: []`, `duration: null`.

**`AudnexusProvider`** — `audnexus.apis.mx/books`. Rate-limited to 100 req/min via module-level token bucket (no npm deps). Used as enrichment only (after ASIN is known from another provider), not in the primary cascade.

**`MetadataResolver`** — orchestrates the provider cascade. Default stack: Audible → OpenLibrary → GoogleBooks; stops at first result with confidence ≥ 0.6. Enriches with Audnexus when ASIN is available. Confidence formula (mirrors ABS BookFinder): `duration_ratio × 0.7 + title_sim × 0.2 + author_sim × 0.1`; when duration unavailable, normalizes title+author weights to 0–1. In-memory LRU cache (500 entries, 1h TTL, per process). Levenshtein fuzzy matching rejects results with normalized edit distance > 0.4.

`resolver.resolve({ title, author, duration })` → `ResolverResult | null`. `ResolverResult`: `{ provider, title, author, series, narrator, publishedYear, asin, confidence }`.

Scanner calls it via `metadataResolver.resolve()`; rules call it via `ctx.resolveMetadata()`.

### `src/core/executor.mjs`

`runExecute(planFile, executeLog, root, { sourceRoot, ... })` processes `pending`, `approved`, and optionally `failed` items. Writes `writePlan` after every item.

`sourceRoot` defaults to `plan.settings.sourceRoot` when not passed explicitly. When `sourceRoot` differs from `root` (ingest mode), the executor builds `allowedRoots = [root, sourceRoot]` and passes it to all `safeMove`/`deleteItem` calls so sources outside the library can be moved/removed safely.

Synthesized `DUP*`, `GD*`, and `CF*` items are processed as follows:
- `action: 'delete'` (`junk: true`) — deleted only when `--delete-junk` is passed
- `action: 'move'` (`junk: false`) — moved to `dest` automatically without any extra flag

### `src/gui-server.mjs`

Express 5. SPA fallback uses `/{*splat}` (named wildcard — Express 5 / path-to-regexp v8 requirement).

Key endpoints:
- `PATCH /api/settings` (updates `plan.settings`; whitelisted keys: `duplicatesFolder`, `sourceRoot`, `destRoot`)
- `PATCH /api/duplicates/:index` (synthesizes `DUP${idx}`)
- `PATCH /api/group-duplicates/:index` (synthesizes `GD${idx}_*`)
- `PATCH /api/conflicts/:index` (ingest mode — synthesizes `CF${idx}_*`; body `{ keep: 'new'|'existing'|'dismiss' }`)
- `GET /api/conflict-meta/:index` (lazy-loads `sourceMeta` and `libraryMeta` via `readTags(..., true)` + `recommendDuplicate`; for directories, samples the first audio file)
- `DELETE /api/*/resolution` (removes synthesized items + clears resolution)
- `POST /api/run/ingest` (body `{ ingestionFolder, libraryRoot }`; spawns `reorganize.mjs --root <libraryRoot> --ingest <ingestionFolder>` via the shared `spawnRun('ingest', ...)` machinery)
- `POST /api/run/execute` — when `plan.settings.sourceRoot` is present, automatically appends `--ingest <sourceRoot>` so the executor sees both roots
- `/api/fs/ls` (scoped: ROOT plus `plan.settings.sourceRoot` and `plan.settings.destRoot` if present)

`getRoot()` priority: `plan.settings.destRoot` → `plan.ignoreFile` parent → `plan.root` → server `--root` flag. The destRoot-first priority means ingest plans correctly treat the library (not the ingest source) as ROOT.

Duplicate resolution synthesis: if `plan.settings.duplicatesFolder` is set, the synthesized item uses `action: 'move'` with `dest = path.join(duplicatesFolder, path.relative(ROOT, discardFile))` and `junk: false`. Otherwise `action: 'delete'`, `dest: null`, `junk: true`.

Conflict resolution synthesis (`keep: 'new'`): same `duplicatesFolder` logic — when set, the existing library file's eviction is `action: 'move'` (lands in dup folder); otherwise `action: 'delete'` + `junk: true`. A second `CF${idx}_move` item is always synthesized to bring the ingested copy into the library.

Allowed PATCH fields for items: `status` (pending/approved/skipped only), `dest`, `bestGuess`, `fallbackDest`. `done` and `failed` are read-only.

---

## GUI Architecture (`gui/`)

Vite 6 + React 19 + Tailwind CSS v4. Separate package with its own `node_modules`. Built output → `../gui-dist/`. Dev proxy: `/api` → `http://localhost:7000`.

**`DuplicateCard.jsx`** — side-by-side comparison; falls back to `/api/duplicate-meta/:index` for plans missing `f1Meta`/`f2Meta`. Accepts `duplicatesFolder` prop; shows "Will move to…" vs "Will delete:" in the resolved state and updates button tooltips accordingly.

**`GroupDuplicateCard.jsx`** — combined file vs. chapters comparison. Expandable file list for the chapter side. Resolution adds items via `PATCH /api/group-duplicates/:index`. Accepts `duplicatesFolder` prop for the same move/delete labelling.

**`ConflictCard.jsx`** (ingest mode) — modeled on `DuplicateCard.jsx`. Props: `conflict`, `index`, `sourceRoot`, `libraryRoot`, `duplicatesFolder`. Two columns labeled "Ingested (new)" / "In Library (existing)". Buttons: **Keep New** (replace library copy), **Keep Existing** (ingestion source stays put), **Not a conflict** (dismiss → move proceeds), and **Undo** post-resolution. Lazy-loads metadata via `/api/conflict-meta/:index`. Rendered from `plan.conflicts[]` in a dedicated section at the top of `App.jsx` (above Best Guesses) because conflicts block execution of the corresponding move.

**`PlanSection.jsx`** — groups items by first 2 path segments relative to ROOT. Per-group and global Approve All / Skip All.

**`RunControls.jsx`** — SSE via `EventSource('/api/run/stream')`; replays buffered output for new connections.
- **Library root** input row (always visible): destination of moves.
- **Ingest from** input row (optional): when non-empty, the "Dry Run" button label flips to "Ingest (Dry Run)" and POSTs to `/api/run/ingest` with `{ ingestionFolder, libraryRoot }`. Blank = normal library scan.
- Options panel: "Duplicates folder" text input persists to `plan.settings` via `PATCH /api/settings`; blank = delete mode.
- The ingestion-folder field is prefilled from `plan.settings.sourceRoot` on subsequent sessions.

**`PlanStats.jsx`** — header strip; shows "conflicts unresolved" count alongside duplicates/best-guess/skipped counts.

**`usePlan.js`** — React Query hooks. Conflict-related: `useResolveConflict`, `useUndoConflict`, `useConflictMeta`, `useStartIngest`.

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
