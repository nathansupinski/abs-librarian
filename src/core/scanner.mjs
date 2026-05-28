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
import { cleanBookTitle } from './title-utils.mjs';
import { buildLibraryIndex } from './library-index.mjs';

// ============================================================
// SCAN IMPLEMENTATION
// ============================================================

export async function runDryScan(root, { planFile, glossaryPath, ignoreFile: ignoreFilePath, duplicatesFolder, scope, destRoot } = {}) {
  const isIngest = !!destRoot && path.resolve(destRoot) !== path.resolve(root);
  destRoot = destRoot ? path.resolve(destRoot) : root;
  console.log(isIngest
    ? `=== INGEST DRY-RUN ===\n  Source: ${root}\n  Library: ${destRoot}\n`
    : '=== DRY-RUN: Scanning audiobooks directory ===\n');
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
  const { planItems, lookupLog, duplicates, groupDuplicates, conflicts, skipLog } = state;
  let { addMove, addJunkMove, addJunkDelete, addBestGuess } = state;
  const { addSkip, addDuplicate, addGroupDuplicate, addConflict, addLookup } = state;

  const relPath = p => path.relative(root, p);
  const checkIgnore = (p, isDir) => matchedIgnoreRule(relPath(p), isDir, ignoreRules);

  // In ingest mode (destRoot differs from source root), pre-build a content
  // index of the destination library so we can detect "this book already
  // exists" conflicts in addition to path collisions.
  let libraryIndex = null;
  if (isIngest) {
    console.log(`[ingest] Building library index from ${destRoot}…`);
    const t0 = Date.now();
    libraryIndex = await buildLibraryIndex(destRoot);
    console.log(`[ingest] Indexed ${libraryIndex.byContent.size} unique books in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }

  // Per-source ID3 metadata recorded by classifier helpers; used by the
  // conflict-check wrapper to do synchronous content matching.
  const sourceMetaByPath = new Map();
  const recordSourceMeta = (p, meta) => {
    if (!p || !meta) return;
    const artist = (meta.artist || '').trim();
    const album  = (meta.album  || '').trim();
    if (!artist && !album) return;
    sourceMetaByPath.set(p, { artist, album });
  };

  const checkConflict = (sourcePath, destPath) => {
    if (!libraryIndex || !sourcePath || !destPath) return null;
    if (statOf(destPath)) {
      return { matchType: 'path', libraryFile: destPath };
    }
    // Look up content match by recorded ID3 metadata (best-effort).
    let meta = sourceMetaByPath.get(sourcePath);
    if (!meta) {
      // For directory sources, check if any recorded child file points back to
      // the same book.
      const prefix = sourcePath + path.sep;
      for (const [p, m] of sourceMetaByPath) {
        if (p.startsWith(prefix)) { meta = m; break; }
      }
    }
    if (!meta?.artist || !meta?.album) return null;
    const key = `${meta.artist.toLowerCase()}|${meta.album.toLowerCase()}`;
    const hits = libraryIndex.byContent.get(key);
    if (!hits?.length) return null;
    return { matchType: 'content', libraryFile: hits[0], sourceMeta: meta };
  };

  // In ingest mode, wrap addMove/addBestGuess to intercept conflicts and
  // route them to the conflicts list instead of the normal items list.
  if (isIngest) {
    const origAddMove = addMove;
    addMove = (source, dest, reason, notes = '', opts = {}) => {
      const c = checkConflict(source, dest);
      if (c) {
        addConflict({ source, dest, reason, notes, ...c });
        return;
      }
      return origAddMove(source, dest, reason, notes, opts);
    };
    const origAddBestGuess = addBestGuess;
    addBestGuess = (source, bestDest, fallbackDest, reason, bestGuessNote, opts = {}) => {
      // Only the "best" dest can collide with the library; fallback goes to
      // _NeedsReview under destRoot and is always per-source-unique.
      const c = bestDest ? checkConflict(source, bestDest) : null;
      if (c) {
        addConflict({ source, dest: bestDest, reason, notes: bestGuessNote, ...c });
        return;
      }
      return origAddBestGuess(source, bestDest, fallbackDest, reason, bestGuessNote, opts);
    };
  }

  // ctx is built here — function declarations below (scanBookForJunk etc.) are hoisted
  const ctx = {
    addMove, addJunkMove, addJunkDelete, addBestGuess,
    addSkip, addDuplicate, addGroupDuplicate, addLookup,
    root, destRoot,
    destPath: (...segs) => path.join(destRoot, ...segs),
    relPath, checkIgnore,
    listDir, statOf, isAudio, isSystemFile, isJunkFile,
    hasAudioRecursive, isDoubleNested,
    readTags, recommendDuplicate, searchOpenLibrary,
    resolveMetadata: (q) => metadataResolver.resolve(q),
    recordSourceMeta,
    scanBookForJunk,
    // Set by processAuthorDir before iterating; rules can read to learn about
    // Author/Series/Book structure even before recursing.
    seriesContainers: null,
    // Set by processSeriesContainer while recursing into a confirmed series
    // folder; rules use this to keep destinations under Author/Series/.
    currentSeries: null,
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
      addMove(p, path.join(destRoot, '_non-audiobook', e), 'non-audiobook content');
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
  // Skip in ingest mode — the source (ingestion) folder being empty after a
  // move is desired, not a junk-cleanup target. The library scan handles its
  // own empty-shell cleanup at execute time when --delete-empty-shells is set.
  if (!isIngest) {
    console.log('\n[Pass 3] Scanning for empty directories...');
    scanForEmptyDirs(root, 0);
  }

  // ---- Write outputs -------------------------------------------------
  const settings = {
    ...(duplicatesFolder ? { duplicatesFolder } : {}),
    ...(isIngest ? { sourceRoot: root, destRoot } : {}),
  };
  const plan = buildPlanOutput({ planItems, lookupLog, duplicates, groupDuplicates, conflicts, skipLog, ignoreFile: ignoreFilePath, settings });
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
  if (isIngest) console.log(`  Conflicts        : ${conflicts.length}  (existing library books)`);
  console.log(`  Skipped          : ${skipLog.length}  (ignore rules + hard-protected)`);
  console.log('\nReview REORGANIZATION_GLOSSARY.md, then run with --execute.');

  async function classifyRootMp3(filePath, filename) {
    const name = path.basename(filename, path.extname(filename));
    const tags = await readTags(filePath, true);
    recordSourceMeta(filePath, tags);
    let author = tags.artist, bookTitle = tags.album || name;
    let method = 'id3-tags', confidence = author ? 'high' : 'none', ambiguous = false;
    let providerMatch = null;
    const warnings = tags._durationTimedOut
      ? ['Audio duration unavailable (file too large to scan in time). Provider match based on title & author only — verify destination is correct.']
      : undefined;

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

    const itemOpts = { ...(providerMatch ? { providerMatch } : {}), ...(warnings ? { warnings } : {}) };
    if (!author || ambiguous) {
      addBestGuess(filePath, null, path.join(destRoot, '_NeedsReview', filename),
        'root-level MP3 — author unknown',
        ambiguous ? `Ambiguous: multiple results for "${name}"`
                  : `Could not identify author for "${name}"`,
        itemOpts);
      return;
    }
    addMove(filePath, path.join(destRoot, author, bookTitle, filename),
      `root-level MP3 → ${author}/${bookTitle}/`,
      '', itemOpts);
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
    const dest = series && title ? path.join(destRoot, author, series, title)
               : series          ? path.join(destRoot, author, series)
               : title           ? path.join(destRoot, author, title)
                                 : path.join(destRoot, author, dirName);
    addMove(dirPath, dest, `misplaced book folder → ${path.relative(destRoot, dest)}/`, info.note);
  }

  async function classifyUnknownTopLevelBook(dirPath, dirName) {
    const af = listDir(dirPath).find(isAudio);
    let author = null, bookTitle = dirName;
    let fileDuration = null;
    let durationTimedOut = false;
    if (af) {
      const afPath = path.join(dirPath, af);
      const tags = await readTags(afPath, true);
      recordSourceMeta(afPath, tags);
      recordSourceMeta(dirPath, tags);
      author = tags.artist;
      if (tags.album) bookTitle = tags.album;
      fileDuration = tags.duration;
      durationTimedOut = tags._durationTimedOut ?? false;
    }
    let method = 'id3-tags', confidence = author ? 'medium' : 'none', ambiguous = false;
    let providerMatch = null;
    const warnings = durationTimedOut
      ? ['Audio duration unavailable (file too large to scan in time). Provider match based on title & author only — verify destination is correct.']
      : undefined;

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

    const fallback = path.join(destRoot, '_NeedsReview', dirName);
    const itemOpts = { ...(providerMatch ? { providerMatch } : {}), ...(warnings ? { warnings } : {}) };
    if (!author || ambiguous) {
      addBestGuess(dirPath, null, fallback, 'unknown top-level book dir — author unresolved',
        ambiguous ? 'Ambiguous search results' : 'No author info found',
        itemOpts);
      return;
    }
    addMove(dirPath, path.join(destRoot, author, bookTitle),
      `unknown top-level book dir → ${author}/${bookTitle}/`,
      '', itemOpts);
  }

  async function processAuthorDir(authorPath, authorName) {
    const entries = listDir(authorPath).sort();

    // Detect series containers BEFORE running rules so rule hooks
    // (e.g. series-detection.onAuthorDir) can read ctx.seriesContainers and
    // seed their own state from it.
    const seriesContainers = await detectSeriesContainers(authorPath, authorName, entries);
    ctx.seriesContainers = seriesContainers;

    try {
      for (const rule of rules) {
        if (await rule.onAuthorDir(authorPath, authorName, ctx)) return;
      }
      console.log(`  ${authorName}`);
      for (const e of entries) {
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
        if (s.isDirectory()) {
          const containerSeries = seriesContainers.get(e);
          if (containerSeries) {
            await processSeriesContainer(p, containerSeries, authorName, authorPath);
          } else {
            await processBookDir(p, e, authorName, authorPath);
          }
        }
      }
    } finally {
      ctx.seriesContainers = null;
    }
  }

  /**
   * Identify which children of authorPath are series containers — folders
   * holding multiple book subdirs that the provider confirms as a real series
   * whose name matches the folder name.
   *
   * Returns Map<dirName, seriesName>. The seriesName is the provider's
   * canonical form (preserves casing) and is used as the destination folder
   * when books inside are moved.
   */
  async function detectSeriesContainers(authorPath, authorName, entries) {
    const containers = new Map();
    for (const e of entries) {
      if (e.startsWith('.') || HARD_SKIP.has(e) || NON_AUDIOBOOK_DIRS.has(e)) continue;
      const p = path.join(authorPath, e);
      const s = statOf(p);
      if (!s?.isDirectory()) continue;

      const children = listDir(p);
      const directAudio = children.filter(n => isAudio(n) && !n.startsWith('._'));
      if (directAudio.length > 0) continue;

      const subdirs = children.filter(n => {
        const sp = path.join(p, n);
        return statOf(sp)?.isDirectory() && !n.startsWith('.') && !HARD_SKIP.has(n);
      });
      const subdirsWithAudio = subdirs.filter(n => hasAudioRecursive(path.join(p, n)));
      if (subdirsWithAudio.length < 2) continue;

      // Use the first audio-bearing child's album tag (or, failing that, the
      // child folder name) as the representative title.
      const repName = subdirsWithAudio[0];
      const repPath = path.join(p, repName);
      const repAudio = listDir(repPath).find(n => isAudio(n) && !n.startsWith('._'));
      let title = null;
      let duration = null;
      if (repAudio) {
        const tags = await readTags(path.join(repPath, repAudio), true);
        title = tags.album || null;
        duration = tags.duration ?? null;
      }
      if (!title) title = cleanBookTitle(repName, authorName);

      const r = await metadataResolver.resolve({ title, author: authorName, duration });
      if (!r || r.confidence < 0.55 || !r.series?.length) continue;

      const folderLc = e.toLowerCase().replace(/^the\s+/i, '');
      let matched = null;
      for (const sObj of r.series) {
        if (!sObj.series) continue;
        const seriesLc = sObj.series.toLowerCase().replace(/^the\s+/i, '');
        if (folderLc === seriesLc) { matched = sObj.series; break; }
      }
      if (matched) {
        containers.set(e, matched);
        addLookup({
          filename: e,
          method: `provider:${r.provider}`,
          result: `series container: ${authorName} / ${matched}`,
          confidence: r.confidence >= 0.85 ? 'high' : 'medium',
          notes: `Container holds ${subdirsWithAudio.length} book subdirs; ${r.provider} ${Math.round(r.confidence * 100)}%`,
        });
      }
    }
    return containers;
  }

  /**
   * Recurse into a confirmed series container, processing each child subdir
   * as a book belonging to that series. ctx.currentSeries is set so rules
   * can produce destinations under Author/Series/Book.
   */
  async function processSeriesContainer(containerPath, seriesName, authorName, authorPath) {
    console.log(`  ${authorName} / [series] ${seriesName}`);
    const prev = ctx.currentSeries;
    ctx.currentSeries = seriesName;
    try {
      for (const e of listDir(containerPath).sort()) {
        const p = path.join(containerPath, e);
        const s = statOf(p);
        if (!s) continue;

        const rule = checkIgnore(p, s.isDirectory());
        if (rule) { addSkip(p, `ignore rule: "${rule}"`); continue; }

        if (isSystemFile(e)) { addJunkDelete(p, 'system/metadata file'); continue; }

        if (s.isFile()) {
          if (isJunkFile(e)) addJunkDelete(p, `junk file in ${authorName}/${seriesName}/`);
          else if (isAudio(e)) {
            // A loose audio file directly inside the series container — treat
            // it as a book under the series.
            await processLooseAudioInSeries(p, e, seriesName, authorName, authorPath);
          }
          else addSkip(p, 'misc non-audio file — left in place');
          continue;
        }
        if (s.isDirectory()) await processBookDir(p, e, authorName, authorPath);
      }
    } finally {
      ctx.currentSeries = prev;
    }
  }

  async function processLooseAudioInSeries(filePath, filename, seriesName, authorName, authorPath) {
    const name = path.basename(filename, path.extname(filename));
    const tags = await readTags(filePath);
    recordSourceMeta(filePath, tags);
    const bookTitle = tags.album || name;
    addLookup({
      filename, method: 'id3-tags',
      result: `${authorName} / ${seriesName} / ${bookTitle}`,
      confidence: tags.album ? 'high' : 'medium',
      notes: `Loose audio inside series container; album="${tags.album || '(not set)'}"`,
    });
    addMove(filePath, ctx.destPath(authorName, seriesName, bookTitle, filename),
      `loose audio → ${authorName}/${seriesName}/${bookTitle}/`);
  }

  async function processLooseAudio(filePath, filename, authorName, authorPath) {
    const name = path.basename(filename, path.extname(filename));
    const tags = await readTags(filePath);
    recordSourceMeta(filePath, tags);
    const bookTitle = tags.album || name;

    // Look for an existing destination subfolder (in the library, not the
    // source). In normal mode destRoot === root so this is unchanged.
    const destAuthorDir = ctx.destPath(authorName);
    const existDir = [path.join(destAuthorDir, bookTitle), path.join(destAuthorDir, name)]
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
    addMove(filePath, ctx.destPath(authorName, bookTitle, filename),
      `loose audio → new ${authorName}/${bookTitle}/`);
  }

  async function processBookDir(bookPath, bookName, authorName, authorPath) {
    for (const rule of rules) {
      if (await rule.onBookDir(bookPath, bookName, authorName, authorPath, ctx)) return;
    }

    if (!hasAudioRecursive(bookPath)) return;

    if (isDoubleNested(bookPath)) {
      const inner = path.join(bookPath, bookName);
      addMove(inner, ctx.destPath(authorName, bookName + '__unwrapped'),
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
