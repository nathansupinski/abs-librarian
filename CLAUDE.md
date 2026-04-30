# abs-librarian — Developer Reference

This file is the technical reference for AI-assisted development on this project. It documents non-obvious architecture decisions, edge cases, and invariants that aren't evident from reading the code.

## What This Tool Does

Reorganizes an Audiobookshelf library from ad-hoc structures to the expected `Author/[Series/]Title/audiofiles` convention. Runs dry-run first (generates a human-reviewable plan), then execute. Never deletes real audio files.

## Architecture Overview

Single-file Node.js ESM script (`reorganize.mjs`). Two top-level modes controlled by `--execute`:
- **Dry-run**: three-pass scan → builds in-memory plan → writes `plan.json` + `REORGANIZATION_GLOSSARY.md`
- **Execute**: reads `plan.json`, processes each item, writes status back after every item (for restartability)

### Three-Pass Scan (dry-run)

1. **Pass 1 — Root files**: classifies each file at the library root. Audio files → ID3 tags + OpenLibrary fallback. Junk/system → junk DELETE.
2. **Pass 2 — Top-level dirs**: for each directory: hard-skip check → ignore rule check → special handlers (Lee Child, Marion Chesney) → generic author dir processing. Author dirs are recursively scanned for loose audio (needs book subfolder) and junk.
3. **Pass 3 — Empty dirs**: `scanForEmptyDirs(ROOT)` walks the full tree looking for dirs not already in the plan that have no audio → junk DELETE.

### Plan Item Shape

```javascript
{
  id,
  type: 'MOVE_DIR' | 'MOVE_FILE',
  source,           // absolute path
  dest,             // absolute path (null for junk delete)
  reason, notes,
  status: 'pending' | 'done' | 'skipped' | 'failed',
  error,            // populated on failure
  junk: bool,
  action: 'move' | 'delete',
  bestGuess: bool,
  fallbackDest,     // _NeedsReview/ path when bestGuess && !AUTO_ACCEPT_REVIEW
  bestGuessNote,
}
```

`plan.json` is written after every single item during execute — safe to interrupt and restart.

### Path Constants

```javascript
const __scriptDir = path.dirname(new URL(import.meta.url).pathname);
const ROOT        = args['--root'] ?? process.env.AUDIOBOOKS_ROOT ?? '/mnt/user/Audiobooks';
const PLAN_FILE   = path.join(__scriptDir, 'plan.json');   // next to script
const EXECUTE_LOG = path.join(__scriptDir, 'execute.log'); // next to script
const GLOSSARY    = path.join(ROOT, 'REORGANIZATION_GLOSSARY.md'); // in library root
const IGNORE_FILE = args['--ignore-file'] ?? path.join(ROOT, '.audiobooksignore');
```

### HARD_SKIP

Dirs always skipped regardless of ignore file:
```javascript
const HARD_SKIP = new Set(['_NeedsReview', '_non-audiobook', '.claude']);
```

## Key Functions

### `isSystemFile(name)`
Returns true for `SYSTEM_NAMES` set members **or** `name.startsWith('._')`. The `._` prefix is the Mac AppleDouble resource fork convention — these files are always junk regardless of extension (e.g., `._foo.mp3` is not audio).

### `safeMove(src, dest)`
Three cases:
1. **Parent→child** (`dest.startsWith(src + '/')`): Linux `rename()` returns EINVAL. Fix: shuffle via sibling temp — `renameSync(src, src+'__reorg_tmp')`, `mkdirSync(src)`, `renameSync(tmp, dest)`. Restores tmp→src on error.
2. **Same filesystem**: `renameSync` (atomic).
3. **Cross-filesystem** (EXDEV, common on Unraid shfs union): `copyTree` + `verifyTree` (byte-size comparison per file) + `removeTree`.

### `deleteItem(p)`
Safety checks in order:
1. Path must be inside `ROOT` — hard exit otherwise.
2. `._*` prefix → skip audio check (resource fork, never real audio regardless of extension).
3. `isAudio(basename)` → throw unless `FORCE_DELETE_AUDIO_JUNK` set.

### `matchedIgnoreRule(relPath, isDir)`
Checks `ignoreRules` array (loaded from `.audiobooksignore`). Rules:
- Trailing `/`: dirs only
- No `/` in pattern: match any path component at any depth
- `/` in pattern: match full relative path from ROOT
- Returns matching rule string or `null`

**Important**: ignore rules are checked before ANY other classification. They always win over system/junk detection.

### `cleanEmptyShells(dir, depth)`
Post-execute cleanup (only with `--delete-empty-shells`). Walks bottom-up. Removes a dir if it has no audio and all remaining files are system/junk/hidden. Never removes ROOT (depth 0 guard).

## Special Case Handlers

### Lee Child / Jack Reacher
- `isDoubleNested(bookPath)`: true when the only real subdir has the same name as the parent and there's no audio at the top level.
- Double-nested: moves inner dir to `Lee Child/Jack Reacher/NN - Title/`; outer shell becomes empty and is cleaned by `--delete-empty-shells`.
- `parseLeeChildFolder(name)`: regex for `Lee.Child.-.Jack.Reacher.NN.-.Title` pattern.

### Marion Chesney (Agatha Raisin + Hamish Macbeth)
- `parseAgathRaisinFolder`: matches `Agatha Raisin NN - Title`.
- `parseMCBeatonFolder`: matches `M C Beaton - AR##/HM## Title [XofY]` — extracts series code, book number, title, disc number.
- Partial disc folders (XofY pattern) → `bestGuess` items pointing to `Series/NN - Title/Disc N/`.
- `extractDiscInfo(name)`: extracts any `XofY` pattern.

### Root-Level MP3s + Unknown Top-Level Book Dirs
Both use the same resolution pipeline:
1. Read ID3 tags via `music-metadata`: `common.artist`/`common.albumartist` = author, `common.album` = title.
2. No author → `searchOpenLibrary(title)` hits `https://openlibrary.org/search.json?title=...&fields=title,author_name&limit=3`.
3. Single unambiguous result → move to `Author/Title/`.
4. Multiple different authors → `bestGuess` item → `_NeedsReview/` without `--auto-accept-review`.

### Parent→Child EINVAL Case
When `classifyUnknownTopLevelBook` identifies a dir as a single-book folder and the found author matches the dir name (e.g., dir `Aasif Mandvi/` with ID3 artist="Aasif Mandvi", album="Sakina's Restaurant"), the plan item becomes `MOVE_DIR` with dest inside src. The `safeMove` parent→child shuffle handles this.

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

## Unraid-Specific Notes (where this was originally built)

- Library at `/mnt/user/Audiobooks` on Unraid 7.2.2 running as root.
- `/mnt/user/` is shfs (union filesystem over multiple physical disks). Files in the same share can be on different physical disks, so `rename()` may return EXDEV — handled in `safeMove`.
- Never use `/mnt/disk*/` paths directly — always go through `/mnt/user/` to stay on the union layer.
- `music-metadata` v11 is ESM-only, which is why the script is `.mjs` with `import` syntax.

## Known Hardcoded Author Mappings (`KNOWN_MISPLACED`)

The script has a small lookup table for top-level folders that are book/series titles rather than author names:
- `A Column of Fire` → Ken Follett / Kingsbridge
- `Dark Eden-A Novel` → Chris Beckett
- `The Golden Compass` → Philip Pullman / His Dark Materials
- `Information Doesnt Want to Be Free Audiobook` → Cory Doctorow
- `Hank the Cowdog books 01-05` → John R. Erickson / Hank the Cowdog
- `Michael.Watkins.-.The.First.90.Days` → Michael Watkins

Add entries here for any other misplaced top-level folders discovered in the library.

## Adding Support for a New Author's Naming Convention

1. Write a `parseXxxFolder(name)` function that returns structured data or null.
2. Add a condition in `processBookDir` (or `processAuthorDir`) to call it.
3. Use `addMove` for confident placements, `addBestGuess` when uncertain.
4. Call `scanBookForJunk` on the source path to catch junk files inside it.
5. Call `addLookup` to log the resolution in the glossary.
