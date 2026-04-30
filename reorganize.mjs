#!/usr/bin/env node
/**
 * abs-librarian — Audiobooks Reorganizer for Audiobookshelf
 *
 * Dry-run (default — generates plan.json + REORGANIZATION_GLOSSARY.md):
 *   node reorganize.mjs --root /path/to/Audiobooks
 *
 * Execute flags (combine freely):
 *   --root <path>            Path to your Audiobooks root directory
 *                            (default: $AUDIOBOOKS_ROOT or /mnt/user/Audiobooks)
 *   --execute                Apply all confirmed moves
 *   --auto-accept-review     Also apply best-guess moves (instead of _NeedsReview/)
 *   --delete-junk            Delete junk/system files and empty dirs
 *   --delete-empty-shells    After all moves, delete dirs containing no audio files
 *   --force-delete-audio-junk  Bypass audio-extension safety check for junk items
 *                            (only needed if ._*.mp3 resource forks not auto-detected)
 *   --retry-failed           Retry items that failed in a previous execute run
 *   --ignore-file <path>     Gitignore-style file; matched paths are preserved/skipped
 *                            (default: <root>/.audiobooksignore)
 *
 * SAFETY: Never deletes real audio files. ._* (Mac resource forks) are always junk.
 * Moves use rename (same-fs) or copy+verify+unlink for cross-disk moves.
 * plan.json and execute.log are written next to this script.
 */

import { parseFile } from 'music-metadata';
import fs from 'fs';
import path from 'path';
import https from 'https';

// ============================================================
// CLI FLAGS
// ============================================================

const args = process.argv.slice(2);
const EXECUTE_MODE            = args.includes('--execute');
const AUTO_ACCEPT_REVIEW      = args.includes('--auto-accept-review');
const DELETE_JUNK             = args.includes('--delete-junk');
const DELETE_EMPTY_SHELLS     = args.includes('--delete-empty-shells');
const FORCE_DELETE_AUDIO_JUNK = args.includes('--force-delete-audio-junk');
const RETRY_FAILED            = args.includes('--retry-failed');

const rootIdx = args.indexOf('--root');
const ignoreFileIdx = args.indexOf('--ignore-file');

// ============================================================
// CONFIG
// ============================================================

// Script directory — plan.json and execute.log live here alongside the script
const __scriptDir = path.dirname(new URL(import.meta.url).pathname);

const ROOT     = rootIdx >= 0 ? args[rootIdx + 1]
               : process.env.AUDIOBOOKS_ROOT
               || '/mnt/user/Audiobooks';

const PLAN_FILE   = path.join(__scriptDir, 'plan.json');
const EXECUTE_LOG = path.join(__scriptDir, 'execute.log');
const GLOSSARY    = path.join(ROOT, 'REORGANIZATION_GLOSSARY.md');

const IGNORE_FILE = ignoreFileIdx >= 0
  ? args[ignoreFileIdx + 1]
  : path.join(ROOT, '.audiobooksignore');

// Hardcoded — never touch these regardless of ignore file
const HARD_SKIP = new Set([
  '_NeedsReview', '_non-audiobook', '.claude',
]);

const NON_AUDIOBOOK_DIRS = new Set(['Aaptiv']);

const AUDIO_EXTS   = new Set(['.mp3', '.MP3', '.m4b', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.WMA', '.oldmp3']);
const JUNK_EXTS    = new Set(['.url', '.URL', '.nzb', '.sfv', '.md5', '.nfo', '.NFO', '.db', '.cue', '.1']);
// System files → junk DELETE (not _misc/)
const SYSTEM_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'thumbs.db', '._.DS_Store', 'desktop.ini', '._.DS_Store']);

const KNOWN_MISPLACED = {
  'A Column of Fire': {
    author: 'Ken Follett', series: 'Kingsbridge', title: 'A Column of Fire',
    confidence: 'high', note: 'Ken Follett, Kingsbridge series book 3',
  },
  'Dark Eden-A Novel': {
    author: 'Chris Beckett', series: null, title: 'Dark Eden',
    confidence: 'high', note: 'Chris Beckett — merging into existing Chris Beckett/ folder',
  },
  'The Golden Compass': {
    author: 'Philip Pullman', series: 'His Dark Materials', title: 'The Golden Compass',
    confidence: 'high', note: 'Philip Pullman, His Dark Materials book 1',
  },
  'Information Doesnt Want to Be Free Audiobook': {
    author: 'Cory Doctorow', series: null, title: "Information Doesn't Want to Be Free",
    confidence: 'medium', note: 'Verify author from ID3 tags',
  },
  'Hank the Cowdog books 01-05': {
    author: 'John R. Erickson', series: 'Hank the Cowdog', title: null,
    confidence: 'high', note: 'Multi-book collection',
  },
  'Michael.Watkins.-.The.First.90.Days': {
    author: 'Michael Watkins', series: null, title: 'The First 90 Days',
    confidence: 'high', note: 'Business book by Michael Watkins',
  },
};

// ============================================================
// IGNORE FILE (gitignore-style)
// ============================================================

let ignoreRules = [];

function loadIgnoreFile(filepath) {
  if (!statOf(filepath)) return [];
  return fs.readFileSync(filepath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function globToRegex(pattern) {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex special chars
    .replace(/\*\*/g, '\x00')                 // placeholder for **
    .replace(/\*/g, '[^/]*')                  // * = anything but slash
    .replace(/\x00/g, '.*')                   // ** = anything
    .replace(/\?/g, '[^/]');                  // ? = one non-slash char
}

// Returns the matching rule string, or null
function matchedIgnoreRule(relPath, isDir) {
  for (const rule of ignoreRules) {
    const dirOnly = rule.endsWith('/');
    if (dirOnly && !isDir) continue;
    const p = rule.replace(/\/$/, '').replace(/^\//, '');
    const re = new RegExp(`^${globToRegex(p)}$`, 'i');
    // Pattern with slash → match full relPath; without → match any path component
    if (p.includes('/')) {
      if (re.test(relPath)) return rule;
    } else {
      const parts = relPath.split('/');
      if (parts.some(part => re.test(part))) return rule;
    }
  }
  return null;
}

// ============================================================
// PLAN STORAGE
// ============================================================
//
// Plan item:
// {
//   id, type ('MOVE_DIR'|'MOVE_FILE'), source, dest,
//   reason, notes, status,
//   junk: bool,        // true = junk item
//   action: str,       // 'move' (to dest) | 'delete' (dest=null, delete with --delete-junk)
//   bestGuess: bool,
//   fallbackDest: str, // used when bestGuess && !AUTO_ACCEPT_REVIEW
//   bestGuessNote: str,
// }

let planItems  = [];
let lookupLog  = [];
let duplicates = [];
let skipLog    = [];

function _addItem(obj) { planItems.push({ id: `${obj.type[0]}${planItems.length}`, status: 'pending', ...obj }); }

function addMove(source, dest, reason, notes = '') {
  const type = statOf(source)?.isDirectory() ? 'MOVE_DIR' : 'MOVE_FILE';
  _addItem({ type, source, dest, reason, notes, junk: false, action: 'move', bestGuess: false });
}

// Junk: move to _misc/ (or delete with --delete-junk)
function addJunkMove(source, dest, reason) {
  _addItem({ type: 'MOVE_FILE', source, dest, reason, junk: true, action: 'move', bestGuess: false });
}

// Junk: always delete (system files, empty dirs); skipped without --delete-junk
function addJunkDelete(source, reason) {
  const type = statOf(source)?.isDirectory() ? 'MOVE_DIR' : 'MOVE_FILE';
  _addItem({ type, source, dest: null, reason, junk: true, action: 'delete', bestGuess: false });
}

function addBestGuess(source, bestDest, fallbackDest, reason, bestGuessNote) {
  const type = statOf(source)?.isDirectory() ? 'MOVE_DIR' : 'MOVE_FILE';
  _addItem({ type, source, dest: bestDest, fallbackDest, reason, bestGuessNote,
    junk: false, action: 'move', bestGuess: true });
}

function addSkip(source, reason) { skipLog.push({ source, reason }); }
function addDuplicate(f1, f2, note) { duplicates.push({ f1, f2, note }); }
function addLookup(obj) { lookupLog.push(obj); }

// ============================================================
// FILESYSTEM UTILITIES
// ============================================================

function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function statOf(p)  { try { return fs.statSync(p); }   catch { return null; } }

function isAudio(n)  { return AUDIO_EXTS.has(path.extname(n)); }
function isSystemFile(n) { return SYSTEM_NAMES.has(n) || n.startsWith('._'); }
function isJunkFile(n)   { return JUNK_EXTS.has(path.extname(n)); }

function hasAudioRecursive(dir) {
  for (const e of listDir(dir)) {
    if (isAudio(e)) return true;
    const p = path.join(dir, e);
    if (statOf(p)?.isDirectory() && !e.startsWith('.') && !HARD_SKIP.has(e))
      if (hasAudioRecursive(p)) return true;
  }
  return false;
}

function isDoubleNested(dirPath) {
  const name = path.basename(dirPath);
  const entries = listDir(dirPath).filter(e => !isSystemFile(e) && !e.startsWith('.'));
  const dirs  = entries.filter(e => statOf(path.join(dirPath, e))?.isDirectory());
  const audios = entries.filter(e => isAudio(e));
  return dirs.length === 1 && dirs[0] === name && audios.length === 0;
}

function relPath(p) { return path.relative(ROOT, p); }

// ============================================================
// NAME PARSERS
// ============================================================

function parseLeeChildFolder(name) {
  const m1 = name.match(/^Lee\.Child\.-\.Jack\.Reacher\.(\d{2})\.-\.(.+)$/i);
  if (m1) return { num: m1[1], title: m1[2].replace(/\./g, ' ').trim() };
  const m2 = name.match(/^Lee\.Child\.-Jack\.Reacher\.(\d{2})\.-\.(.+)$/i);
  if (m2) return { num: m2[1], title: m2[2].replace(/\./g, ' ').trim() };
  return null;
}

function parseAgathRaisinFolder(name) {
  const m = name.match(/^Agatha Raisin\s+(\d{1,2})\s+-\s+(.+)$/i);
  return m ? { num: m[1].padStart(2, '0'), title: m[2].trim() } : null;
}

function parseMCBeatonFolder(name) {
  const cleaned = name.replace(/^Hamish flood\s+/i, '');
  const ar = cleaned.match(/^M[. ]C[. ]\s*Beaton\s+-\s+AR(\d{2})\s+(.+?)(?:\s+(\d+)of(\d+))?$/i);
  if (ar) return { series: 'Agatha Raisin', num: ar[1].padStart(2,'0'), title: ar[2].trim(),
    disc: ar[3] ? +ar[3] : null, totalDiscs: ar[4] ? +ar[4] : null };
  const hm = cleaned.match(/^M[. ]C[. ]\s*Beaton\s+-\s+HM(\d{2})\s+(.+?)(?:\s+(\d+)of(\d+))?$/i);
  if (hm) return { series: 'Hamish Macbeth', num: hm[1].padStart(2,'0'), title: hm[2].trim(),
    disc: hm[3] ? +hm[3] : null, totalDiscs: hm[4] ? +hm[4] : null };
  return null;
}

function extractDiscInfo(name) {
  const m = name.match(/(\d+)of(\d+)/i);
  return m ? { disc: +m[1], totalDiscs: +m[2] } : null;
}

// ============================================================
// ID3 TAG READING
// ============================================================

async function readTags(filePath) {
  try {
    const meta = await parseFile(filePath, { duration: false, skipPostHeaders: true });
    const c = meta.common;
    return { artist: c.artist || c.albumartist || null, album: c.album || null };
  } catch { return { artist: null, album: null }; }
}

// ============================================================
// OPENLIBRARY SEARCH
// ============================================================

function searchOpenLibrary(title) {
  return new Promise(resolve => {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&fields=title,author_name&limit=3`;
    const req = https.get(url, { timeout: 12000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const docs = (JSON.parse(data).docs || []).slice(0,3)
            .map(d => ({ title: d.title, author: (d.author_name||[])[0]||null }));
          const found = docs.length > 0 && docs[0].author;
          const ambiguous = docs.length > 1 &&
            docs[0].author?.toLowerCase() !== docs[1].author?.toLowerCase();
          resolve({ found: !!found, docs, ambiguous: !!ambiguous });
        } catch(e) { resolve({ found:false, docs:[], ambiguous:false, error:e.message }); }
      });
    });
    req.on('error', e => resolve({ found:false, docs:[], ambiguous:false, error:e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ found:false, docs:[], ambiguous:false, error:'timeout' }); });
  });
}

// ============================================================
// PLAN GENERATION
// ============================================================

async function generatePlan() {
  console.log('=== DRY-RUN: Scanning audiobooks directory ===\n');

  ignoreRules = loadIgnoreFile(IGNORE_FILE);
  if (ignoreRules.length > 0)
    console.log(`Loaded ${ignoreRules.length} ignore rules from ${IGNORE_FILE}\n`);

  const rootEntries = listDir(ROOT).sort();

  // Pass 1: root-level files
  console.log('[Pass 1] Root-level files...');
  for (const e of rootEntries) {
    const p = path.join(ROOT, e);
    if (!statOf(p)?.isFile()) continue;

    const rule = matchedIgnoreRule(e, false);
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (isSystemFile(e)) { addJunkDelete(p, `system/metadata file`); continue; }
    if (isJunkFile(e))   { addJunkDelete(p, `junk file at root`); continue; }
    if (e.startsWith('.')) { addJunkDelete(p, 'hidden file at root'); continue; }
    if (isAudio(e)) { await classifyRootMp3(p, e); continue; }
    addSkip(p, `non-audio root file (${path.extname(e)||'no ext'})`);
  }

  // Pass 2: root-level directories
  console.log('\n[Pass 2] Top-level directories...');
  for (const e of rootEntries) {
    const p = path.join(ROOT, e);
    if (!statOf(p)?.isDirectory()) continue;

    if (HARD_SKIP.has(e)) { addSkip(p, 'hard-protected directory'); continue; }

    const rule = matchedIgnoreRule(e, true);
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (e.startsWith('.')) { addJunkDelete(p, 'hidden/system directory'); continue; }

    if (NON_AUDIOBOOK_DIRS.has(e)) {
      addMove(p, path.join(ROOT, '_non-audiobook', e), 'non-audiobook content');
      continue;
    }
    if (KNOWN_MISPLACED[e]) { await classifyMisplacedBookFolder(p, e, KNOWN_MISPLACED[e]); continue; }

    // Top-level dir with only audio at root and no subdirs → unknown book folder
    const audioAtRoot = listDir(p).filter(isAudio);
    const subDirs = listDir(p).filter(n => statOf(path.join(p,n))?.isDirectory() && !n.startsWith('.'));
    if (audioAtRoot.length > 0 && subDirs.length === 0) {
      await classifyUnknownTopLevelBook(p, e); continue;
    }

    await processAuthorDir(p, e);
  }

  // Pass 3: find empty directories anywhere in the tree (not already planned)
  console.log('\n[Pass 3] Scanning for empty directories...');
  scanForEmptyDirs(ROOT, 0);
}

// ---- classifiers ----------------------------------------------------

async function classifyRootMp3(filePath, filename) {
  const name = path.basename(filename, path.extname(filename));
  const tags = await readTags(filePath);
  let author = tags.artist, bookTitle = tags.album || name;
  let method = 'id3-tags', confidence = author ? 'high' : 'none', ambiguous = false;
  let searchDocs = null;

  if (!author) {
    method = 'openlibrary';
    const r = await searchOpenLibrary(name);
    searchDocs = r.docs;
    if (r.found && !r.ambiguous)     { author = r.docs[0].author; bookTitle = r.docs[0].title||name; confidence = 'medium'; }
    else if (r.found && r.ambiguous) { confidence = 'low'; ambiguous = true; }
  }

  addLookup({ filename, method,
    result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
    confidence, ambiguous,
    notes: searchDocs
      ? `OL: ${searchDocs.map(d=>`"${d.title}" by ${d.author}`).join(' | ')}`
      : `ID3: artist="${tags.artist||''}", album="${tags.album||''}"`,
  });

  if (!author || ambiguous) {
    addBestGuess(filePath, null, path.join(ROOT, '_NeedsReview', filename),
      'root-level MP3 — author unknown',
      ambiguous ? `Ambiguous: multiple authors found for "${name}"`
                : `Could not identify author for "${name}"`);
    return;
  }
  addMove(filePath, path.join(ROOT, author, bookTitle, filename),
    `root-level MP3 → ${author}/${bookTitle}/`);
}

async function classifyMisplacedBookFolder(dirPath, dirName, info) {
  let { author, series, title } = info;
  if (info.confidence === 'medium') {
    const af = listDir(dirPath).find(isAudio);
    if (af) {
      const tags = await readTags(path.join(dirPath, af));
      if (tags.artist) author = tags.artist;
    }
    addLookup({ filename: dirName, method: 'id3-verification',
      result: `${author} / ${title}`, confidence: 'high',
      notes: `ID3 confirmed; original guess was "${info.author}"` });
  } else {
    addLookup({ filename: dirName, method: 'known-mapping',
      result: `${author} / ${title||dirName}`, confidence: info.confidence, notes: info.note });
  }
  let dest = series && title ? path.join(ROOT, author, series, title)
           : series          ? path.join(ROOT, author, series)
           : title           ? path.join(ROOT, author, title)
                             : path.join(ROOT, author, dirName);
  addMove(dirPath, dest, `misplaced book folder → ${relPath(dest)}/`, info.note);
}

async function classifyUnknownTopLevelBook(dirPath, dirName) {
  const af = listDir(dirPath).find(isAudio);
  let author = null, bookTitle = dirName;
  if (af) { const tags = await readTags(path.join(dirPath, af)); author = tags.artist; if (tags.album) bookTitle = tags.album; }
  let method = 'id3-tags', confidence = author ? 'medium' : 'none', ambiguous = false;

  if (!author) {
    method = 'openlibrary';
    const r = await searchOpenLibrary(dirName);
    if (r.found && !r.ambiguous)     { author = r.docs[0].author; bookTitle = r.docs[0].title||dirName; confidence = 'medium'; }
    else if (r.found && r.ambiguous) { ambiguous = true; confidence = 'low'; }
  }

  addLookup({ filename: dirName, method,
    result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
    confidence, ambiguous,
    notes: `Top-level dir with ${listDir(dirPath).filter(isAudio).length} audio files at root`,
  });

  const fallback = path.join(ROOT, '_NeedsReview', dirName);
  if (!author || ambiguous) {
    addBestGuess(dirPath, null, fallback, 'unknown top-level book dir — author unresolved',
      ambiguous ? 'Ambiguous search results' : 'No author info found');
    return;
  }
  addMove(dirPath, path.join(ROOT, author, bookTitle), `unknown top-level book dir → ${author}/${bookTitle}/`);
}

// ---- author directory -----------------------------------------------

async function processAuthorDir(authorPath, authorName) {
  console.log(`  ${authorName}`);
  for (const e of listDir(authorPath).sort()) {
    const p = path.join(authorPath, e);
    const s = statOf(p);
    if (!s) continue;

    // Ignore file check applies at every depth
    const rule = matchedIgnoreRule(relPath(p), s.isDirectory());
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (isSystemFile(e)) { addJunkDelete(p, `system/metadata file`); continue; }

    if (s.isFile()) {
      if (isAudio(e))      await processLooseAudio(p, e, authorName, authorPath);
      else if (isJunkFile(e)) addJunkDelete(p, 'junk file in author dir');
      else                 addSkip(p, 'misc non-audio file — left in place');
      continue;
    }
    if (s.isDirectory()) await processBookDir(p, e, authorName, authorPath);
  }
}

async function processLooseAudio(filePath, filename, authorName, authorPath) {
  const name = path.basename(filename, path.extname(filename));
  const tags = await readTags(filePath);
  const bookTitle = tags.album || name;

  const existDir = [path.join(authorPath, bookTitle), path.join(authorPath, name)]
    .find(d => statOf(d)?.isDirectory());

  if (existDir) {
    const targetFile = path.join(existDir, filename);
    if (statOf(targetFile)) {
      addDuplicate(filePath, targetFile, 'Same filename in existing book subfolder');
      addSkip(filePath, 'duplicate — see Duplicates section');
      return;
    }
    addLookup({ filename, method: 'id3-tags', result: `${authorName} / ${path.basename(existDir)}`,
      confidence: 'high', notes: `Merging into existing subfolder; album="${tags.album}"` });
    addMove(filePath, targetFile, `loose audio → existing ${authorName}/${path.basename(existDir)}/`);
    return;
  }

  addLookup({ filename, method: 'id3-tags', result: `${authorName} / ${bookTitle}`,
    confidence: tags.album ? 'high' : 'medium',
    notes: `New subfolder; album="${tags.album||'(not set)'}"` });
  addMove(filePath, path.join(authorPath, bookTitle, filename),
    `loose audio → new ${authorName}/${bookTitle}/`);
}

// ---- book directory -------------------------------------------------

async function processBookDir(bookPath, bookName, authorName, authorPath) {
  if (authorName === 'Lee Child')    { await processLeeChildBook(bookPath, bookName); return; }
  if (authorName === 'Marion Chesney') { await processMarionChesneyBook(bookPath, bookName, authorPath); return; }

  // Check ignore rules for this book dir's contents
  // (the dir itself was already checked before calling this function)

  if (!hasAudioRecursive(bookPath)) {
    // No audio — will be picked up by Pass 3 empty dir scan
    return;
  }

  if (isDoubleNested(bookPath)) {
    const inner = path.join(bookPath, bookName);
    addMove(inner, path.join(authorPath, bookName + '__unwrapped'),
      `collapsed double-nested dir in ${authorName}/`,
      `Outer shell "${bookName}" will be empty — use --delete-empty-shells`);
    scanBookForJunk(bookPath, bookName, authorName, false); // outer shell junk
    return;
  }

  scanBookForJunk(bookPath, bookName, authorName, true);
}

// ---- Lee Child ------------------------------------------------------

async function processLeeChildBook(bookPath, bookName) {
  if (!hasAudioRecursive(bookPath)) return; // picked up by Pass 3

  const parsed = parseLeeChildFolder(bookName);
  if (parsed) {
    const { num, title } = parsed;
    const dest = path.join(ROOT, 'Lee Child', 'Jack Reacher', `${num} - ${title}`);
    if (isDoubleNested(bookPath)) {
      const inner = path.join(bookPath, bookName);
      addMove(inner, dest, `Lee Child double-nested → Jack Reacher/${num} - ${title}/`,
        `Outer shell "${bookName}" will be empty — use --delete-empty-shells`);
      scanBookForJunk(inner, bookName, 'Lee Child', true);
    } else {
      addMove(bookPath, dest, `Lee Child → Jack Reacher/${num} - ${title}/`);
      scanBookForJunk(bookPath, bookName, 'Lee Child', true);
    }
    addLookup({ filename: bookName, method: 'filename-parse',
      result: `Lee Child / Jack Reacher / ${num} - ${title}`, confidence: 'high',
      notes: 'Parsed from Lee.Child.-.Jack.Reacher.NN.-.Title pattern' });
    return;
  }

  const clean = bookName.replace(/\./g, ' ').trim();
  const bestDest = path.join(ROOT, 'Lee Child', 'Jack Reacher', clean);
  addBestGuess(bookPath, bestDest, path.join(ROOT, '_NeedsReview', bookName),
    'Lee Child folder — naming pattern not recognized',
    `Guessed: Jack Reacher / "${clean}"`);
  addLookup({ filename: bookName, method: 'unmatched-pattern',
    result: `Lee Child / Jack Reacher / ${clean}`, confidence: 'low', ambiguous: true,
    notes: 'Does not match Lee.Child.-.Jack.Reacher.NN.-.Title' });
}

// ---- Marion Chesney -------------------------------------------------

async function processMarionChesneyBook(bookPath, bookName, authorPath) {
  if (!hasAudioRecursive(bookPath)) return;

  const ar = parseAgathRaisinFolder(bookName);
  if (ar) {
    addMove(bookPath, path.join(authorPath, 'Agatha Raisin', `${ar.num} - ${ar.title}`),
      `Marion Chesney → Agatha Raisin/${ar.num} - ${ar.title}/`);
    addLookup({ filename: bookName, method: 'filename-parse',
      result: `Marion Chesney / Agatha Raisin / ${ar.num} - ${ar.title}`, confidence: 'high', notes: '' });
    scanBookForJunk(bookPath, bookName, 'Marion Chesney', true);
    return;
  }

  const mcb = parseMCBeatonFolder(bookName);
  if (mcb) {
    const bookDest = path.join(authorPath, mcb.series, `${mcb.num} - ${mcb.title}`);
    if (mcb.disc !== null) {
      const discDest = path.join(bookDest, `Disc ${mcb.disc}`);
      const note = `Disc ${mcb.disc}${mcb.totalDiscs?' of '+mcb.totalDiscs:''} for "${mcb.title}". Book may be incomplete.`;
      addBestGuess(bookPath, discDest, path.join(ROOT, '_NeedsReview', bookName),
        `Marion Chesney partial disc → ${mcb.series}/${mcb.num} - ${mcb.title}/Disc ${mcb.disc}/`, note);
      addLookup({ filename: bookName, method: 'filename-parse',
        result: `Marion Chesney / ${mcb.series} / ${mcb.num} - ${mcb.title} / Disc ${mcb.disc}`,
        confidence: 'high', notes: note });
    } else {
      addMove(bookPath, bookDest, `Marion Chesney → ${mcb.series}/${mcb.num} - ${mcb.title}/`);
      addLookup({ filename: bookName, method: 'filename-parse',
        result: `Marion Chesney / ${mcb.series} / ${mcb.num} - ${mcb.title}`, confidence: 'high', notes: '' });
      scanBookForJunk(bookPath, bookName, 'Marion Chesney', true);
    }
    return;
  }

  // XofY disc we couldn't fully identify
  const discInfo = extractDiscInfo(bookName);
  if (discInfo) {
    const af = listDir(bookPath).find(isAudio);
    let guessTitle = bookName;
    if (af) { const tags = await readTags(path.join(bookPath, af)); if (tags.album) guessTitle = tags.album; }
    addBestGuess(bookPath, path.join(authorPath, guessTitle, `Disc ${discInfo.disc}`),
      path.join(ROOT, '_NeedsReview', bookName),
      'Marion Chesney disc folder — partially parsed',
      `Disc ${discInfo.disc} of ${discInfo.totalDiscs}. Guessed title: "${guessTitle}".`);
    addLookup({ filename: bookName, method: 'id3+filename',
      result: `Marion Chesney / ${guessTitle} / Disc ${discInfo.disc}`,
      confidence: 'low', ambiguous: true, notes: 'Series code not recognized; using ID3 album tag' });
    return;
  }

  // Standalone or unrecognized — leave in place, just clean junk
  scanBookForJunk(bookPath, bookName, 'Marion Chesney', true);
}

// ---- scan book for junk files ---------------------------------------

function scanBookForJunk(bookPath, bookName, authorName, recursive) {
  for (const e of listDir(bookPath)) {
    const p = path.join(bookPath, e);
    const s = statOf(p);
    if (!s) continue;

    const rule = matchedIgnoreRule(relPath(p), s.isDirectory());
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (s.isDirectory()) {
      if (recursive) scanBookForJunk(p, e, authorName, true);
      continue;
    }

    if (isSystemFile(e)) { addJunkDelete(p, `system/metadata file`); continue; }
    if (isJunkFile(e))   { addJunkMove(p, path.join(bookPath, '_misc', e),
        `junk file → _misc/ in ${authorName}/${bookName}/`); }
  }
}

// ---- Pass 3: find empty directories ---------------------------------

function scanForEmptyDirs(dir, depth) {
  for (const e of listDir(dir).sort()) {
    const p = path.join(dir, e);
    if (!statOf(p)?.isDirectory()) continue;
    if (HARD_SKIP.has(e)) continue;

    const rule = matchedIgnoreRule(relPath(p), true);
    if (rule) continue; // already in skip log from earlier pass (or not scanned)

    if (depth === 0 && e.startsWith('.')) continue; // handled above

    // Skip dirs that are already sources/dests of planned moves
    if (planItems.some(i => i.source === p || i.dest === p)) continue;

    if (!hasAudioRecursive(p)) {
      // No audio at all — check if it has any non-junk, non-system content
      const contents = listDir(p).filter(n => !isSystemFile(n) && !n.startsWith('.') && !isJunkFile(n));
      addJunkDelete(p, contents.length === 0
        ? 'empty directory'
        : `directory with no audio files (contains: ${contents.slice(0,3).join(', ')}${contents.length>3?'…':''})`);
      continue; // Don't recurse into dirs we'll delete
    }

    scanForEmptyDirs(p, depth + 1);
  }
}

// ============================================================
// GLOSSARY WRITER
// ============================================================

function writeGlossary() {
  const confirmed  = planItems.filter(i => !i.bestGuess && !i.junk);
  const bestGuess  = planItems.filter(i => i.bestGuess);
  const junkItems  = planItems.filter(i => i.junk);
  const junkDel    = junkItems.filter(i => i.action === 'delete');
  const junkMove   = junkItems.filter(i => i.action === 'move');

  const rel = p => p ? p.replace(ROOT + '/', '') : '—';
  const esc = s => (s||'').replace(/\|/g, '\\|');

  const lines = [
    '# Audiobooks Reorganization Glossary',
    '',
    `> **Generated:** ${new Date().toISOString()}`,
    `> **Ignore file:** \`${IGNORE_FILE}\` (${ignoreRules.length} rules)`,
    `> **Mode:** DRY RUN — no files have been touched`,
    '',
    '---',
    '## Summary',
    '',
    '| Category | Count |',
    '|---|---|',
    `| Confirmed moves | ${confirmed.length} |`,
    `| Best-guess moves | ${bestGuess.length} |`,
    `| Junk — delete (system files, empty dirs) | ${junkDel.length} |`,
    `| Junk — move to _misc/ (download artifacts) | ${junkMove.length} |`,
    `| Duplicates flagged | ${duplicates.length} |`,
    `| Lookups performed | ${lookupLog.length} |`,
    `| Skipped (ignore rules + hard-protected) | ${skipLog.length} |`,
    '',
    '**Execute commands:**',
    '```',
    '# Confirmed moves only:',
    'node /mnt/user/Audiobooks/.claude/reorg/reorganize.mjs --execute',
    '',
    '# Everything — apply best guesses, delete junk, clean empty shells:',
    'node /mnt/user/Audiobooks/.claude/reorg/reorganize.mjs --execute --auto-accept-review --delete-junk --delete-empty-shells',
    '```',
    '',
    '---',
    '## Confirmed Moves',
    '',
    '| # | Type | Source | Destination | Reason | Notes |',
    '|---|---|---|---|---|---|',
  ];

  confirmed.forEach((i, n) =>
    lines.push(`| ${n+1} | ${i.type} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | ${esc(i.reason)} | ${esc(i.notes||'')} |`));

  lines.push(
    '', '---',
    '## Best-Guess Moves',
    '',
    '> Without `--auto-accept-review`: go to `_NeedsReview/`.',
    '> With `--auto-accept-review`: go to **Best Guess Destination**.',
    '',
    '| # | Type | Source | Best Guess Destination | _NeedsReview/ Fallback | Note |',
    '|---|---|---|---|---|---|',
  );
  bestGuess.forEach((i, n) =>
    lines.push(`| ${n+1} | ${i.type} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | \`${esc(rel(i.fallbackDest))}\` | ${esc(i.bestGuessNote||'')} |`));

  lines.push(
    '', '---',
    '## Junk Items',
    '',
    '> **DELETE** items: system/metadata files and empty dirs.',
    '> - Without `--delete-junk`: skipped (left in place)',
    '> - With `--delete-junk`: permanently removed',
    '',
    '> **MOVE** items: download artifacts (.URL, .nzb, etc.)',
    '> - Without `--delete-junk`: moved to `_misc/` within the book folder',
    '> - With `--delete-junk`: permanently removed',
    '',
    '| Action | Source | Destination | Reason |',
    '|---|---|---|---|',
  );
  junkItems.forEach(i =>
    lines.push(`| ${i.action==='delete'?'**DELETE**':'MOVE→_misc_'} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | ${esc(i.reason)} |`));

  lines.push(
    '', '---',
    '## Author/Title Lookup Log',
    '',
    '| Filename | Method | Result | Confidence | Ambiguous? | Notes |',
    '|---|---|---|---|---|---|',
  );
  lookupLog.forEach(e =>
    lines.push(`| \`${esc(e.filename)}\` | ${e.method} | ${esc(e.result)} | ${e.confidence} | ${e.ambiguous?'⚠️ YES':'No'} | ${esc(e.notes)} |`));

  lines.push(
    '', '---',
    '## Duplicate Files',
    '',
    '> Do not delete either — decide manually which to keep.',
    '',
    '| File 1 | File 2 | Note |',
    '|---|---|---|',
  );
  duplicates.forEach(d =>
    lines.push(`| \`${esc(rel(d.f1))}\` | \`${esc(rel(d.f2))}\` | ${esc(d.note)} |`));

  lines.push(
    '', '---',
    '## Skipped / Preserved',
    '',
    '> Hard-protected dirs and paths matched by ignore rules.',
    '',
    '| Path | Reason |',
    '|---|---|',
  );
  skipLog.forEach(s =>
    lines.push(`| \`${esc(rel(s.source))}\` | ${esc(s.reason)} |`));

  lines.push('', '---', '*Generated by reorganize.mjs*');
  fs.writeFileSync(GLOSSARY, lines.join('\n') + '\n');
  console.log(`Glossary → ${GLOSSARY}`);
}

function savePlan() {
  fs.writeFileSync(PLAN_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ignoreFile: IGNORE_FILE,
    items: planItems, lookupLog, duplicates, skipLog,
  }, null, 2));
  console.log(`Plan    → ${PLAN_FILE}`);
}

// ============================================================
// EXECUTE
// ============================================================

function copyTree(src, dest) {
  const s = statOf(src);
  if (!s) throw new Error(`Source missing: ${src}`);
  if (s.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of listDir(src)) copyTree(path.join(src,e), path.join(dest,e));
  } else { fs.copyFileSync(src, dest); }
}
function verifyTree(src, dest) {
  const ss = statOf(src), ds = statOf(dest);
  if (!ds) throw new Error(`Copy missing: ${dest}`);
  if (ss.isDirectory()) {
    for (const e of listDir(src)) verifyTree(path.join(src,e), path.join(dest,e));
  } else if (ss.size !== ds.size) throw new Error(`Size mismatch: ${src} (${ss.size}) vs ${dest} (${ds.size})`);
}
function removeTree(p) {
  if (!p.startsWith(ROOT + '/')) throw new Error(`Safety: will not remove outside ROOT: ${p}`);
  const s = statOf(p);
  if (!s) return;
  if (s.isDirectory()) { for (const e of listDir(p)) removeTree(path.join(p,e)); fs.rmdirSync(p); }
  else fs.unlinkSync(p);
}
function safeMove(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (statOf(dest)) return 'SKIP_EXISTS';

  // Cannot rename a directory into a subdirectory of itself (EINVAL).
  // Shuffle via a sibling temp dir: rename src→tmp, recreate src, rename tmp→dest.
  if (dest.startsWith(src + '/') || dest.startsWith(src + path.sep)) {
    const tmp = src + '__reorg_tmp';
    if (statOf(tmp)) throw new Error(`Temp path already exists: ${tmp}`);
    fs.renameSync(src, tmp);
    try {
      fs.mkdirSync(src, { recursive: true }); // restore empty parent dir
      try { fs.renameSync(tmp, dest); }
      catch(e) {
        if (e.code !== 'EXDEV') throw e;
        copyTree(tmp, dest); verifyTree(tmp, dest); removeTree(tmp);
      }
    } catch(e) {
      // Attempt to restore original state before re-throwing
      try { if (!statOf(src + path.sep + path.basename(dest))) fs.renameSync(tmp, src); } catch {}
      throw e;
    }
    return 'renamed';
  }

  try { fs.renameSync(src, dest); return 'renamed'; }
  catch(e) {
    if (e.code !== 'EXDEV') throw e;
    copyTree(src, dest); verifyTree(src, dest); removeTree(src);
    return 'copied';
  }
}
function deleteItem(p) {
  if (!p.startsWith(ROOT + '/')) throw new Error(`Safety: will not delete outside ROOT: ${p}`);
  const base = path.basename(p);
  // ._* files are Mac AppleDouble resource forks — never real audio despite extension
  const isMacResourceFork = base.startsWith('._');
  if (!isMacResourceFork && isAudio(base) && !FORCE_DELETE_AUDIO_JUNK)
    throw new Error(`Safety: refusing to delete audio file: ${p}`);
  removeTree(p);
}

// Post-execute: delete dirs with no audio (bottom-up)
function cleanEmptyShells(dir, depth) {
  if (HARD_SKIP.has(path.basename(dir)) || !statOf(dir)?.isDirectory()) return;
  const entries = listDir(dir);
  for (const e of entries) {
    const p = path.join(dir, e);
    if (statOf(p)?.isDirectory()) cleanEmptyShells(p, depth + 1);
  }
  if (depth === 0) return; // never delete ROOT
  if (!hasAudioRecursive(dir)) {
    const remaining = listDir(dir);
    if (remaining.every(e => isSystemFile(e) || isJunkFile(e) || e.startsWith('.'))) {
      try {
        for (const e of remaining) { const p = path.join(dir,e); if(statOf(p)?.isFile()) fs.unlinkSync(p); }
        fs.rmdirSync(dir);
        const msg = `DONE   deleted  ${relPath(dir)} (empty shell)`;
        console.log(msg); fs.appendFileSync(EXECUTE_LOG, msg + '\n');
      } catch(e) {
        const msg = `FAIL   delete   ${relPath(dir)}: ${e.message}`;
        console.log(msg); fs.appendFileSync(EXECUTE_LOG, msg + '\n');
      }
    }
  }
}

async function executePlan() {
  console.log('=== EXECUTE MODE ===');
  console.log(`  --auto-accept-review     : ${AUTO_ACCEPT_REVIEW}`);
  console.log(`  --delete-junk            : ${DELETE_JUNK}`);
  console.log(`  --delete-empty-shells    : ${DELETE_EMPTY_SHELLS}`);
  console.log(`  --force-delete-audio-junk: ${FORCE_DELETE_AUDIO_JUNK}`);
  console.log(`  --retry-failed           : ${RETRY_FAILED}\n`);

  if (!statOf(PLAN_FILE)) { console.error('No plan.json — run dry-run first.'); process.exit(1); }

  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));

  // Items to process: always pending; also failed if --retry-failed
  const toProcess = plan.items.filter(i =>
    i.status === 'pending' || (RETRY_FAILED && i.status === 'failed'));

  const pendingCount = toProcess.filter(i => i.status === 'pending').length;
  const retryCount   = toProcess.filter(i => i.status === 'failed').length;
  console.log(`${pendingCount} pending${retryCount ? `, ${retryCount} failed (retrying)` : ''} items\n`);

  // Execute log — append so multiple runs accumulate
  const runHeader = [
    `\n${'='.repeat(72)}`,
    `=== EXECUTE RUN: ${new Date().toISOString()} ===`,
    `Flags: --execute` +
      (AUTO_ACCEPT_REVIEW     ? ' --auto-accept-review'      : '') +
      (DELETE_JUNK            ? ' --delete-junk'             : '') +
      (DELETE_EMPTY_SHELLS    ? ' --delete-empty-shells'     : '') +
      (FORCE_DELETE_AUDIO_JUNK? ' --force-delete-audio-junk' : '') +
      (RETRY_FAILED           ? ' --retry-failed'            : ''),
    `Items: ${pendingCount} pending${retryCount ? `, ${retryCount} retrying` : ''}`,
    `${'='.repeat(72)}`,
  ].join('\n');
  fs.appendFileSync(EXECUTE_LOG, runHeader + '\n');

  function logExec(line) {
    console.log(line);
    fs.appendFileSync(EXECUTE_LOG, line + '\n');
  }

  let done = 0, skipped = 0, failed = 0;

  for (const item of toProcess) {
    if (!statOf(item.source)) {
      item.status = 'skipped'; item.error = 'source no longer exists'; skipped++;
      fs.appendFileSync(EXECUTE_LOG, `SKIP   (gone)   ${relPath(item.source)}\n`);
      fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
      continue;
    }

    // Resolve effective destination
    let dest = item.dest;
    if (item.bestGuess) dest = AUTO_ACCEPT_REVIEW ? item.dest : item.fallbackDest;

    // Junk: delete or move
    if (item.junk) {
      if (DELETE_JUNK) {
        try {
          deleteItem(item.source);
          logExec(`DONE   deleted  ${relPath(item.source)}`);
          item.status = 'done'; delete item.error; done++;
        } catch(e) {
          logExec(`FAIL   delete   ${relPath(item.source)}: ${e.message}`);
          item.status = 'failed'; item.error = e.message; failed++;
        }
      } else if (item.action === 'move' && dest) {
        try {
          const r = safeMove(item.source, dest);
          if (r === 'SKIP_EXISTS') {
            logExec(`SKIP   exists   ${relPath(dest)}`);
            item.status = 'skipped'; skipped++;
          } else {
            logExec(`DONE   ${r.padEnd(7)} ${relPath(item.source)} → ${relPath(dest)}`);
            item.status = 'done'; delete item.error; done++;
          }
        } catch(e) {
          logExec(`FAIL   move     ${relPath(item.source)}: ${e.message}`);
          item.status = 'failed'; item.error = e.message; failed++;
        }
      } else {
        // action=delete but --delete-junk not set → skip silently
        item.status = 'skipped'; skipped++;
      }
      fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
      continue;
    }

    // Regular move (confirmed or best-guess)
    if (!dest) {
      item.status = 'skipped'; skipped++;
      fs.appendFileSync(EXECUTE_LOG, `SKIP   no-dest  ${relPath(item.source)}\n`);
      fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
      continue;
    }

    try {
      const r = safeMove(item.source, dest);
      if (r === 'SKIP_EXISTS') {
        logExec(`SKIP   exists   ${relPath(dest)}`);
        item.status = 'skipped'; skipped++;
      } else {
        logExec(`DONE   ${r.padEnd(7)} ${relPath(item.source)} → ${relPath(dest)}`);
        item.status = 'done'; delete item.error; done++;
      }
    } catch(e) {
      logExec(`FAIL   move     ${relPath(item.source)}: ${e.message}`);
      item.status = 'failed'; item.error = e.message; failed++;
    }
    fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
  }

  const summary = `\n--- SUMMARY: ${done} done, ${skipped} skipped, ${failed} failed ---`;
  logExec(summary);
  fs.appendFileSync(EXECUTE_LOG, '\n');

  if (DELETE_EMPTY_SHELLS) {
    console.log('\n[Cleaning empty shells...]');
    fs.appendFileSync(EXECUTE_LOG, '[Cleaning empty shells...]\n');
    for (const e of listDir(ROOT).sort()) {
      const p = path.join(ROOT, e);
      if (statOf(p)?.isDirectory() && !HARD_SKIP.has(e) && !e.startsWith('.'))
        cleanEmptyShells(p, 1);
    }
  }

  if (failed > 0)
    console.log(`\nSome items failed. Check execute.log for details.\nRe-run with --execute --retry-failed to retry them.`);
  console.log(`Execute log: ${EXECUTE_LOG}`);
  console.log('Done.');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (EXECUTE_MODE) {
    await executePlan();
  } else {
    await generatePlan();
    savePlan();
    writeGlossary();

    const confirmed = planItems.filter(i => !i.bestGuess && !i.junk);
    const bestGuess = planItems.filter(i => i.bestGuess);
    const junkDel   = planItems.filter(i => i.junk && i.action === 'delete');
    const junkMove  = planItems.filter(i => i.junk && i.action === 'move');

    console.log('\n=== Summary ===');
    console.log(`  Confirmed moves  : ${confirmed.length}`);
    console.log(`  Best-guess moves : ${bestGuess.length}`);
    console.log(`  Junk DELETE      : ${junkDel.length}  (system files + empty dirs)`);
    console.log(`  Junk MOVE→_misc_ : ${junkMove.length}  (download artifacts)`);
    console.log(`  Duplicates       : ${duplicates.length}`);
    console.log(`  Skipped          : ${skipLog.length}  (ignore rules + hard-protected)`);
    console.log('\nReview REORGANIZATION_GLOSSARY.md, then run with --execute.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
