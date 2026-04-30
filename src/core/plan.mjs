import fs from 'fs';
import path from 'path';
import { statOf } from './fs-utils.mjs';

export function readPlan(planFile) {
  return JSON.parse(fs.readFileSync(planFile, 'utf8'));
}

export function writePlan(planFile, plan) {
  const tmp = planFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, planFile);
}

// Returns a mutable plan state object + all the add* helpers.
// Pass the result into scanner.mjs so state is local to each invocation.
export function createPlanState() {
  const planItems  = [];
  const lookupLog  = [];
  const duplicates = [];
  const skipLog    = [];

  function _addItem(obj) {
    planItems.push({ id: `${obj.type[0]}${planItems.length}`, status: 'pending', ...obj });
  }

  function addMove(source, dest, reason, notes = '') {
    const type = statOf(source)?.isDirectory() ? 'MOVE_DIR' : 'MOVE_FILE';
    _addItem({ type, source, dest, reason, notes, junk: false, action: 'move', bestGuess: false });
  }

  function addJunkMove(source, dest, reason) {
    _addItem({ type: 'MOVE_FILE', source, dest, reason, junk: true, action: 'move', bestGuess: false });
  }

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
  function addDuplicate(f1, f2, note, meta = {}) { duplicates.push({ f1, f2, note, ...meta }); }
  function addLookup(obj) { lookupLog.push(obj); }

  return {
    planItems, lookupLog, duplicates, skipLog,
    addMove, addJunkMove, addJunkDelete, addBestGuess,
    addSkip, addDuplicate, addLookup,
  };
}

export function buildPlanOutput({ planItems, lookupLog, duplicates, skipLog, ignoreFile }) {
  return {
    generatedAt: new Date().toISOString(),
    ignoreFile,
    items: planItems,
    lookupLog,
    duplicates,
    skipLog,
  };
}

export function writeGlossary(glossaryPath, { planItems, lookupLog, duplicates, skipLog, root, ignoreFile, ignoreRules }) {
  const confirmed = planItems.filter(i => !i.bestGuess && !i.junk);
  const bestGuess = planItems.filter(i => i.bestGuess);
  const junkItems = planItems.filter(i => i.junk);
  const junkDel   = junkItems.filter(i => i.action === 'delete');
  const junkMove  = junkItems.filter(i => i.action === 'move');

  const rel = p => p ? path.relative(root, p) : '—';
  const esc = s => (s || '').replace(/\|/g, '\\|');

  const lines = [
    '# Audiobooks Reorganization Glossary',
    '',
    `> **Generated:** ${new Date().toISOString()}`,
    `> **Ignore file:** \`${ignoreFile}\` (${(ignoreRules || []).length} rules)`,
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
    lines.push(`| ${n + 1} | ${i.type} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | ${esc(i.reason)} | ${esc(i.notes || '')} |`));

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
    lines.push(`| ${n + 1} | ${i.type} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | \`${esc(rel(i.fallbackDest))}\` | ${esc(i.bestGuessNote || '')} |`));

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
    lines.push(`| ${i.action === 'delete' ? '**DELETE**' : 'MOVE→_misc_'} | \`${esc(rel(i.source))}\` | \`${esc(rel(i.dest))}\` | ${esc(i.reason)} |`));

  lines.push(
    '', '---',
    '## Author/Title Lookup Log',
    '',
    '| Filename | Method | Result | Confidence | Ambiguous? | Notes |',
    '|---|---|---|---|---|---|',
  );
  lookupLog.forEach(e =>
    lines.push(`| \`${esc(e.filename)}\` | ${e.method} | ${esc(e.result)} | ${e.confidence} | ${e.ambiguous ? '⚠️ YES' : 'No'} | ${esc(e.notes)} |`));

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
  fs.writeFileSync(glossaryPath, lines.join('\n') + '\n');
  console.log(`Glossary → ${glossaryPath}`);
}
