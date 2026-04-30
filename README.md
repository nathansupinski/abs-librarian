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

Node.js 18+ and the `music-metadata` npm package:

```bash
npm install
```

---

## Quickstart

```bash
# 1. Generate the plan (no files touched)
node reorganize.mjs --root /path/to/Audiobooks

# 2. Review the plan
cat /path/to/Audiobooks/REORGANIZATION_GLOSSARY.md

# 3. Execute
node reorganize.mjs --root /path/to/Audiobooks --execute
```

You can also set `AUDIOBOOKS_ROOT` to avoid repeating the path:

```bash
export AUDIOBOOKS_ROOT=/mnt/user/Audiobooks
node reorganize.mjs          # dry-run
node reorganize.mjs --execute
```

---

## Execute Flags

Combine flags freely. All are optional.

| Flag | Effect |
|---|---|
| `--root <path>` | Path to your Audiobooks root (default: `$AUDIOBOOKS_ROOT` or `/mnt/user/Audiobooks`) |
| `--execute` | Apply all confirmed moves from plan.json |
| `--auto-accept-review` | Use best-guess destinations instead of `_NeedsReview/` |
| `--delete-junk` | Delete system files, Mac metadata, empty dirs, download artifacts |
| `--delete-empty-shells` | After moves, recursively remove dirs that contain no audio |
| `--force-delete-audio-junk` | Bypass audio-extension safety check for junk items (rarely needed; `._*` resource forks are auto-detected) |
| `--retry-failed` | Retry items that failed in a previous execute run |
| `--ignore-file <path>` | Use a custom ignore file (default: `<root>/.audiobooksignore`) |

### Recommended command (full cleanup)

```bash
node reorganize.mjs --root /path/to/Audiobooks --execute --auto-accept-review --delete-junk --delete-empty-shells
```

### Conservative (moves only, no deletions)

```bash
node reorganize.mjs --root /path/to/Audiobooks --execute
```

---

## The Ignore File

Copy `.audiobooksignore.example` to your Audiobooks root as `.audiobooksignore` and edit it to suit:

```bash
cp .audiobooksignore.example /path/to/Audiobooks/.audiobooksignore
```

The format works like `.gitignore`:

```
# Trailing / = directories only
Encrypted/
_NeedsReview/

# No slash = match any path component at any depth
.stfolder

# Full path pattern (contains /)
some/specific/path
```

Anything matched by an ignore rule is left completely untouched and listed in the glossary Skipped section with the rule that matched.

---

## What Happens to Each File Type

| Item | Without `--delete-junk` | With `--delete-junk` |
|---|---|---|
| Confirmed moves | Applied | Applied |
| Best-guess items | → `_NeedsReview/` | → `_NeedsReview/` |
| Best-guess + `--auto-accept-review` | → best-guess dest | → best-guess dest |
| System files (`.DS_Store`, `._*`, etc.) | Left in place | Deleted |
| Download artifacts (`.nzb`, `.sfv`, `.URL`) | → `_misc/` subfolder | Deleted |
| Empty directories | Left in place | Deleted |
| Duplicates | Left in place (flagged in glossary) | Left in place |
| Ignore-matched paths | Always left in place | Always left in place |
| `._*.mp3` Mac resource forks | Left in place | Deleted (auto-detected as non-audio) |

---

## After Execution

**Review `_NeedsReview/`** — files the script couldn't confidently place. Move each one manually.

**Resolve duplicates** — the glossary Duplicate Files section lists any files that exist at two paths. Decide which copy to keep and delete the other manually.

**Rescan Audiobookshelf** — Settings → Libraries → (your library) → Scan Library.

---

## Restartability

`plan.json` is written after every item during execute. If the script is interrupted, re-run `--execute` and it picks up where it left off (pending items only). To also retry previously-failed items, add `--retry-failed`.

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
...
--- SUMMARY: 349 done, 0 skipped, 1 failed ---
```

Multiple runs accumulate in the same file.

---

## Special Cases Handled Automatically

- **Lee Child / Jack Reacher**: double-nested folders (`Lee.Child.-.Jack.Reacher.NN.-.Title/Lee.Child.-.Jack.Reacher.NN.-.Title/`) are collapsed and moved to `Lee Child/Jack Reacher/NN - Title/`
- **Marion Chesney**: Agatha Raisin (`AR##`) and Hamish Macbeth (`HM##`) series codes parsed from folder names; partial disc folders (`XofY`) become `Disc N` subfolders
- **Root-level MP3s**: ID3 tags read first; falls back to OpenLibrary API search; ambiguous results go to `_NeedsReview/`
- **Loose audio in author folders**: wrapped in a per-book subfolder using the ID3 album tag as the title
- **Top-level book folders** (title used as folder name instead of author): remapped to `Author/Title/` using a known-mapping table plus ID3 verification
- **Mac AppleDouble resource forks** (`._*.mp3`): always treated as junk regardless of the `.mp3` extension

---

## Files

| File | Purpose |
|---|---|
| `reorganize.mjs` | Main script |
| `package.json` | npm project (music-metadata dependency) |
| `.audiobooksignore.example` | Template ignore file — copy to your Audiobooks root |
| `CLAUDE.md` | Technical reference for AI-assisted development |
| `plan.json` | Generated at runtime — gitignored, library-specific |
| `execute.log` | Generated at runtime — gitignored, library-specific |
| `<root>/REORGANIZATION_GLOSSARY.md` | Generated at runtime — human-readable dry-run report |
