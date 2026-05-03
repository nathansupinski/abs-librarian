import path from 'path';
import { HARD_SKIP, NON_AUDIOBOOK_DIRS } from './constants.mjs';
import {
  listDir, statOf, isAudio, isSystemFile, isJunkFile,
  hasAudioRecursive, isDoubleNested,
} from './fs-utils.mjs';
import { loadIgnoreFile, matchedIgnoreRule } from './ignore.mjs';
import { readTags, recommendDuplicate, searchOpenLibrary } from './metadata.mjs';
import { resolver as metadataResolver } from '../providers/index.mjs';
import { createPlanState, buildPlanOutput, writePlan, writeGlossary } from './plan.mjs';
import { loadUserMappings } from './user-mappings.mjs';
import { loadRules } from '../rules/loader.mjs';

// ============================================================
// SCAN IMPLEMENTATION
// ============================================================

export async function runDryScan(root, { planFile, glossaryPath, ignoreFile: ignoreFilePath, duplicatesFolder, scope } = {}) {
  console.log('=== DRY-RUN: Scanning audiobooks directory ===\n');
  if (scope) console.log(`Scope filter: only top-level dirs containing "${scope}"\n`);

  const ignoreRules = loadIgnoreFile(ignoreFilePath);
  if (ignoreRules.length > 0)
    console.log(`Loaded ${ignoreRules.length} ignore rules from ${ignoreFilePath}\n`);

  const userMappings = loadUserMappings();
  const knownMisplaced = userMappings.knownMisplaced || {};

  const rules = await loadRules();
  if (rules.length > 0)
    console.log(`Loaded ${rules.length} scan rule(s): ${rules.map(r => r.name).join(', ')}\n`);

  const state = createPlanState();
  const { planItems, lookupLog, duplicates, groupDuplicates, skipLog } = state;
  const { addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip, addDuplicate, addGroupDuplicate, addLookup } = state;

  const relPath = p => path.relative(root, p);
  const checkIgnore = (p, isDir) => matchedIgnoreRule(relPath(p), isDir, ignoreRules);

  // ctx is built here — function declarations below (scanBookForJunk etc.) are hoisted
  const ctx = {
    addMove, addJunkMove, addJunkDelete, addBestGuess,
    addSkip, addDuplicate, addGroupDuplicate, addLookup,
    root, relPath, checkIgnore,
    listDir, statOf, isAudio, isSystemFile, isJunkFile,
    hasAudioRecursive, isDoubleNested,
    readTags, recommendDuplicate, searchOpenLibrary,
    resolveMetadata: (q) => metadataResolver.resolve(q),
    scanBookForJunk,
  };

  // ---- Pass 1: root-level files --------------------------------------
  console.log('[Pass 1] Root-level files...');
  const rootEntries = listDir(root).sort();

  for (const e of rootEntries) {
    const p = path.join(root, e);
    if (!statOf(p)?.isFile()) continue;

    const rule = checkIgnore(p, false);
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (isSystemFile(e)) { addJunkDelete(p, 'system/metadata file'); continue; }
    if (isJunkFile(e))   { addJunkDelete(p, 'junk file at root'); continue; }
    if (e.startsWith('.')) { addJunkDelete(p, 'hidden file at root'); continue; }
    if (isAudio(e)) { await classifyRootMp3(p, e); continue; }
    addSkip(p, `non-audio root file (${path.extname(e) || 'no ext'})`);
  }

  // ---- Pass 2: root-level directories --------------------------------
  console.log('\n[Pass 2] Top-level directories...');
  const scopeLc = scope?.toLowerCase();
  for (const e of rootEntries) {
    const p = path.join(root, e);
    if (!statOf(p)?.isDirectory()) continue;

    if (scopeLc && !e.toLowerCase().includes(scopeLc)) continue;

    if (HARD_SKIP.has(e)) { addSkip(p, 'hard-protected directory'); continue; }

    const rule = checkIgnore(p, true);
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (e.startsWith('.')) { addJunkDelete(p, 'hidden/system directory'); continue; }

    if (NON_AUDIOBOOK_DIRS.has(e)) {
      addMove(p, path.join(root, '_non-audiobook', e), 'non-audiobook content');
      continue;
    }
    if (knownMisplaced[e]) { await classifyMisplacedBookFolder(p, e, knownMisplaced[e]); continue; }

    const audioAtRoot = listDir(p).filter(isAudio);
    const subDirs = listDir(p).filter(n => statOf(path.join(p, n))?.isDirectory() && !n.startsWith('.'));
    if (audioAtRoot.length > 0 && subDirs.length === 0) {
      await classifyUnknownTopLevelBook(p, e); continue;
    }

    await processAuthorDir(p, e);
  }

  // ---- Pass 3: empty directories -------------------------------------
  console.log('\n[Pass 3] Scanning for empty directories...');
  scanForEmptyDirs(root, 0);

  // ---- Write outputs -------------------------------------------------
  const settings = duplicatesFolder ? { duplicatesFolder } : {};
  const plan = buildPlanOutput({ planItems, lookupLog, duplicates, groupDuplicates, skipLog, ignoreFile: ignoreFilePath, settings });
  writePlan(planFile, plan);
  console.log(`Plan    → ${planFile}`);

  writeGlossary(glossaryPath, { planItems, lookupLog, duplicates, groupDuplicates, skipLog, root, ignoreFile: ignoreFilePath, ignoreRules });

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
  console.log(`  Group duplicates : ${groupDuplicates.length}  (combined vs. chapters)`);
  console.log(`  Skipped          : ${skipLog.length}  (ignore rules + hard-protected)`);
  console.log('\nReview REORGANIZATION_GLOSSARY.md, then run with --execute.');

  async function classifyRootMp3(filePath, filename) {
    const name = path.basename(filename, path.extname(filename));
    const tags = await readTags(filePath, true);
    let author = tags.artist, bookTitle = tags.album || name;
    let method = 'id3-tags', confidence = author ? 'high' : 'none', ambiguous = false;
    let providerMatch = null;

    if (!author) {
      const r = await metadataResolver.resolve({ title: name, author: null, duration: tags.duration });
      if (r) {
        providerMatch = r;
        method = `provider:${r.provider}`;
        if (r.confidence >= 0.5) {
          author = r.author;
          bookTitle = r.title || name;
          confidence = r.confidence >= 0.75 ? 'medium' : 'low';
        } else {
          ambiguous = true;
          confidence = 'low';
        }
      }
    }

    addLookup({ filename, method,
      result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
      confidence, ambiguous,
      notes: providerMatch
        ? `${providerMatch.provider}: "${providerMatch.title}" by ${providerMatch.author} (${Math.round(providerMatch.confidence * 100)}%)`
        : `ID3: artist="${tags.artist || ''}", album="${tags.album || ''}"`,
    });

    if (!author || ambiguous) {
      addBestGuess(filePath, null, path.join(root, '_NeedsReview', filename),
        'root-level MP3 — author unknown',
        ambiguous ? `Ambiguous: multiple results for "${name}"`
                  : `Could not identify author for "${name}"`,
        providerMatch ? { providerMatch } : {});
      return;
    }
    addMove(filePath, path.join(root, author, bookTitle, filename),
      `root-level MP3 → ${author}/${bookTitle}/`,
      '', providerMatch ? { providerMatch } : {});
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
        result: `${author} / ${title || dirName}`, confidence: info.confidence, notes: info.note });
    }
    const dest = series && title ? path.join(root, author, series, title)
               : series          ? path.join(root, author, series)
               : title           ? path.join(root, author, title)
                                 : path.join(root, author, dirName);
    addMove(dirPath, dest, `misplaced book folder → ${relPath(dest)}/`, info.note);
  }

  async function classifyUnknownTopLevelBook(dirPath, dirName) {
    const af = listDir(dirPath).find(isAudio);
    let author = null, bookTitle = dirName;
    let fileDuration = null;
    if (af) {
      const tags = await readTags(path.join(dirPath, af), true);
      author = tags.artist;
      if (tags.album) bookTitle = tags.album;
      fileDuration = tags.duration;
    }
    let method = 'id3-tags', confidence = author ? 'medium' : 'none', ambiguous = false;
    let providerMatch = null;

    if (!author) {
      const r = await metadataResolver.resolve({ title: dirName, author: null, duration: fileDuration });
      if (r) {
        providerMatch = r;
        method = `provider:${r.provider}`;
        if (r.confidence >= 0.5) {
          author = r.author;
          bookTitle = r.title || dirName;
          confidence = r.confidence >= 0.75 ? 'medium' : 'low';
        } else {
          ambiguous = true;
          confidence = 'low';
        }
      }
    }

    addLookup({ filename: dirName, method,
      result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
      confidence, ambiguous,
      notes: providerMatch
        ? `${providerMatch.provider}: "${providerMatch.title}" by ${providerMatch.author} (${Math.round(providerMatch.confidence * 100)}%)`
        : `Top-level dir with ${listDir(dirPath).filter(isAudio).length} audio files at root`,
    });

    const fallback = path.join(root, '_NeedsReview', dirName);
    if (!author || ambiguous) {
      addBestGuess(dirPath, null, fallback, 'unknown top-level book dir — author unresolved',
        ambiguous ? 'Ambiguous search results' : 'No author info found',
        providerMatch ? { providerMatch } : {});
      return;
    }
    addMove(dirPath, path.join(root, author, bookTitle),
      `unknown top-level book dir → ${author}/${bookTitle}/`,
      '', providerMatch ? { providerMatch } : {});
  }

  async function processAuthorDir(authorPath, authorName) {
    for (const rule of rules) {
      if (await rule.onAuthorDir(authorPath, authorName, ctx)) return;
    }
    console.log(`  ${authorName}`);
    for (const e of listDir(authorPath).sort()) {
      const p = path.join(authorPath, e);
      const s = statOf(p);
      if (!s) continue;

      const rule = checkIgnore(p, s.isDirectory());
      if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

      if (isSystemFile(e)) { addJunkDelete(p, 'system/metadata file'); continue; }

      if (s.isFile()) {
        if (isAudio(e))        await processLooseAudio(p, e, authorName, authorPath);
        else if (isJunkFile(e)) addJunkDelete(p, 'junk file in author dir');
        else                   addSkip(p, 'misc non-audio file — left in place');
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
        const [dupMeta1, dupMeta2] = await Promise.all([
          readTags(filePath, true),
          readTags(targetFile, true),
        ]);
        const [s1, s2] = [statOf(filePath), statOf(targetFile)];
        addDuplicate(filePath, targetFile, 'Same filename in existing book subfolder', {
          f1Meta: { ...dupMeta1, size: s1?.size ?? null },
          f2Meta: { ...dupMeta2, size: s2?.size ?? null },
          recommendation: recommendDuplicate(dupMeta1, dupMeta2, s1, s2),
        });
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
      notes: `New subfolder; album="${tags.album || '(not set)'}"` });
    addMove(filePath, path.join(authorPath, bookTitle, filename),
      `loose audio → new ${authorName}/${bookTitle}/`);
  }

  async function processBookDir(bookPath, bookName, authorName, authorPath) {
    for (const rule of rules) {
      if (await rule.onBookDir(bookPath, bookName, authorName, authorPath, ctx)) return;
    }

    if (!hasAudioRecursive(bookPath)) return;

    if (isDoubleNested(bookPath)) {
      const inner = path.join(bookPath, bookName);
      addMove(inner, path.join(authorPath, bookName + '__unwrapped'),
        `collapsed double-nested dir in ${authorName}/`,
        `Outer shell "${bookName}" will be empty — use --delete-empty-shells`);
      scanBookForJunk(bookPath, bookName, authorName, false);
      return;
    }

    scanBookForJunk(bookPath, bookName, authorName, true);
  }


  function scanBookForJunk(bookPath, bookName, authorName, recursive) {
    for (const e of listDir(bookPath)) {
      const p = path.join(bookPath, e);
      const s = statOf(p);
      if (!s) continue;

      const rule = checkIgnore(p, s.isDirectory());
      if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

      if (s.isDirectory()) {
        if (recursive) scanBookForJunk(p, e, authorName, true);
        continue;
      }

      if (isSystemFile(e)) { addJunkDelete(p, 'system/metadata file'); continue; }
      if (isJunkFile(e)) {
        addJunkMove(p, path.join(bookPath, '_misc', e),
          `junk file → _misc/ in ${authorName}/${bookName}/`);
      }
    }
  }

  function scanForEmptyDirs(dir, depth) {
    for (const e of listDir(dir).sort()) {
      const p = path.join(dir, e);
      if (!statOf(p)?.isDirectory()) continue;
      if (HARD_SKIP.has(e)) continue;

      const rule = checkIgnore(p, true);
      if (rule) continue;

      if (depth === 0 && e.startsWith('.')) continue;

      if (planItems.some(i => i.source === p || i.dest === p)) continue;

      if (!hasAudioRecursive(p)) {
        const contents = listDir(p).filter(n => !isSystemFile(n) && !n.startsWith('.') && !isJunkFile(n));
        addJunkDelete(p, contents.length === 0
          ? 'empty directory'
          : `directory with no audio files (contains: ${contents.slice(0, 3).join(', ')}${contents.length > 3 ? '…' : ''})`);
        continue;
      }

      scanForEmptyDirs(p, depth + 1);
    }
  }
}
