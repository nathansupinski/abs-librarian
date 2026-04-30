import path from 'path';
import { HARD_SKIP, NON_AUDIOBOOK_DIRS, KNOWN_MISPLACED } from './constants.mjs';
import {
  listDir, statOf, isAudio, isSystemFile, isJunkFile,
  hasAudioRecursive, isDoubleNested,
} from './fs-utils.mjs';
import { loadIgnoreFile, matchedIgnoreRule } from './ignore.mjs';
import { readTags, recommendDuplicate, searchOpenLibrary } from './metadata.mjs';
import { createPlanState, buildPlanOutput, writePlan, writeGlossary } from './plan.mjs';

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
  if (ar) return { series: 'Agatha Raisin', num: ar[1].padStart(2, '0'), title: ar[2].trim(),
    disc: ar[3] ? +ar[3] : null, totalDiscs: ar[4] ? +ar[4] : null };
  const hm = cleaned.match(/^M[. ]C[. ]\s*Beaton\s+-\s+HM(\d{2})\s+(.+?)(?:\s+(\d+)of(\d+))?$/i);
  if (hm) return { series: 'Hamish Macbeth', num: hm[1].padStart(2, '0'), title: hm[2].trim(),
    disc: hm[3] ? +hm[3] : null, totalDiscs: hm[4] ? +hm[4] : null };
  return null;
}

function extractDiscInfo(name) {
  const m = name.match(/(\d+)of(\d+)/i);
  return m ? { disc: +m[1], totalDiscs: +m[2] } : null;
}

// ============================================================
// SCAN IMPLEMENTATION
// ============================================================

export async function runDryScan(root, { planFile, glossaryPath, ignoreFile: ignoreFilePath } = {}) {
  console.log('=== DRY-RUN: Scanning audiobooks directory ===\n');

  const ignoreRules = loadIgnoreFile(ignoreFilePath);
  if (ignoreRules.length > 0)
    console.log(`Loaded ${ignoreRules.length} ignore rules from ${ignoreFilePath}\n`);

  const state = createPlanState();
  const { planItems, lookupLog, duplicates, skipLog } = state;
  const { addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip, addDuplicate, addLookup } = state;

  const relPath = p => path.relative(root, p);
  const checkIgnore = (p, isDir) => matchedIgnoreRule(relPath(p), isDir, ignoreRules);

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
  for (const e of rootEntries) {
    const p = path.join(root, e);
    if (!statOf(p)?.isDirectory()) continue;

    if (HARD_SKIP.has(e)) { addSkip(p, 'hard-protected directory'); continue; }

    const rule = checkIgnore(p, true);
    if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

    if (e.startsWith('.')) { addJunkDelete(p, 'hidden/system directory'); continue; }

    if (NON_AUDIOBOOK_DIRS.has(e)) {
      addMove(p, path.join(root, '_non-audiobook', e), 'non-audiobook content');
      continue;
    }
    if (KNOWN_MISPLACED[e]) { await classifyMisplacedBookFolder(p, e, KNOWN_MISPLACED[e]); continue; }

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
  const plan = buildPlanOutput({ planItems, lookupLog, duplicates, skipLog, ignoreFile: ignoreFilePath });
  writePlan(planFile, plan);
  console.log(`Plan    → ${planFile}`);

  writeGlossary(glossaryPath, { planItems, lookupLog, duplicates, skipLog, root, ignoreFile: ignoreFilePath, ignoreRules });

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

  // ---- Classifier helpers (closures over state + root) ---------------

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
      if (r.found && !r.ambiguous)     { author = r.docs[0].author; bookTitle = r.docs[0].title || name; confidence = 'medium'; }
      else if (r.found && r.ambiguous) { confidence = 'low'; ambiguous = true; }
    }

    addLookup({ filename, method,
      result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
      confidence, ambiguous,
      notes: searchDocs
        ? `OL: ${searchDocs.map(d => `"${d.title}" by ${d.author}`).join(' | ')}`
        : `ID3: artist="${tags.artist || ''}", album="${tags.album || ''}"`,
    });

    if (!author || ambiguous) {
      addBestGuess(filePath, null, path.join(root, '_NeedsReview', filename),
        'root-level MP3 — author unknown',
        ambiguous ? `Ambiguous: multiple authors found for "${name}"`
                  : `Could not identify author for "${name}"`);
      return;
    }
    addMove(filePath, path.join(root, author, bookTitle, filename),
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
    if (af) {
      const tags = await readTags(path.join(dirPath, af));
      author = tags.artist;
      if (tags.album) bookTitle = tags.album;
    }
    let method = 'id3-tags', confidence = author ? 'medium' : 'none', ambiguous = false;

    if (!author) {
      method = 'openlibrary';
      const r = await searchOpenLibrary(dirName);
      if (r.found && !r.ambiguous)     { author = r.docs[0].author; bookTitle = r.docs[0].title || dirName; confidence = 'medium'; }
      else if (r.found && r.ambiguous) { ambiguous = true; confidence = 'low'; }
    }

    addLookup({ filename: dirName, method,
      result: author ? `${author} / ${bookTitle}` : 'NOT FOUND',
      confidence, ambiguous,
      notes: `Top-level dir with ${listDir(dirPath).filter(isAudio).length} audio files at root`,
    });

    const fallback = path.join(root, '_NeedsReview', dirName);
    if (!author || ambiguous) {
      addBestGuess(dirPath, null, fallback, 'unknown top-level book dir — author unresolved',
        ambiguous ? 'Ambiguous search results' : 'No author info found');
      return;
    }
    addMove(dirPath, path.join(root, author, bookTitle), `unknown top-level book dir → ${author}/${bookTitle}/`);
  }

  async function processAuthorDir(authorPath, authorName) {
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
    if (authorName === 'Lee Child')      { await processLeeChildBook(bookPath, bookName); return; }
    if (authorName === 'Marion Chesney') { await processMarionChesneyBook(bookPath, bookName, authorPath); return; }

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

  async function processLeeChildBook(bookPath, bookName) {
    if (!hasAudioRecursive(bookPath)) return;

    const parsed = parseLeeChildFolder(bookName);
    if (parsed) {
      const { num, title } = parsed;
      const dest = path.join(root, 'Lee Child', 'Jack Reacher', `${num} - ${title}`);
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
    const bestDest = path.join(root, 'Lee Child', 'Jack Reacher', clean);
    addBestGuess(bookPath, bestDest, path.join(root, '_NeedsReview', bookName),
      'Lee Child folder — naming pattern not recognized',
      `Guessed: Jack Reacher / "${clean}"`);
    addLookup({ filename: bookName, method: 'unmatched-pattern',
      result: `Lee Child / Jack Reacher / ${clean}`, confidence: 'low', ambiguous: true,
      notes: 'Does not match Lee.Child.-.Jack.Reacher.NN.-.Title' });
  }

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
        const note = `Disc ${mcb.disc}${mcb.totalDiscs ? ' of ' + mcb.totalDiscs : ''} for "${mcb.title}". Book may be incomplete.`;
        addBestGuess(bookPath, discDest, path.join(root, '_NeedsReview', bookName),
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

    const discInfo = extractDiscInfo(bookName);
    if (discInfo) {
      const af = listDir(bookPath).find(isAudio);
      let guessTitle = bookName;
      if (af) { const tags = await readTags(path.join(bookPath, af)); if (tags.album) guessTitle = tags.album; }
      addBestGuess(bookPath, path.join(authorPath, guessTitle, `Disc ${discInfo.disc}`),
        path.join(root, '_NeedsReview', bookName),
        'Marion Chesney disc folder — partially parsed',
        `Disc ${discInfo.disc} of ${discInfo.totalDiscs}. Guessed title: "${guessTitle}".`);
      addLookup({ filename: bookName, method: 'id3+filename',
        result: `Marion Chesney / ${guessTitle} / Disc ${discInfo.disc}`,
        confidence: 'low', ambiguous: true, notes: 'Series code not recognized; using ID3 album tag' });
      return;
    }

    scanBookForJunk(bookPath, bookName, 'Marion Chesney', true);
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
