import fs from 'fs';
import path from 'path';
import { HARD_SKIP } from './constants.mjs';
import { listDir, statOf, safeMove, deleteItem, cleanEmptyShells } from './fs-utils.mjs';
import { readPlan, writePlan } from './plan.mjs';

export async function runExecute(planFile, executeLog, root, {
  autoAcceptReview = false,
  deleteJunk = false,
  deleteEmptyShells = false,
  forceDeleteAudioJunk = false,
  retryFailed = false,
} = {}) {
  console.log('=== EXECUTE MODE ===');
  console.log(`  --auto-accept-review     : ${autoAcceptReview}`);
  console.log(`  --delete-junk            : ${deleteJunk}`);
  console.log(`  --delete-empty-shells    : ${deleteEmptyShells}`);
  console.log(`  --force-delete-audio-junk: ${forceDeleteAudioJunk}`);
  console.log(`  --retry-failed           : ${retryFailed}\n`);

  if (!statOf(planFile)) { console.error('No plan.json — run dry-run first.'); process.exit(1); }

  const plan = readPlan(planFile);

  const toProcess = plan.items.filter(i =>
    i.status === 'pending' || i.status === 'approved' ||
    (retryFailed && i.status === 'failed'));

  const pendingCount = toProcess.filter(i => i.status === 'pending' || i.status === 'approved').length;
  const retryCount   = toProcess.filter(i => i.status === 'failed').length;
  console.log(`${pendingCount} pending${retryCount ? `, ${retryCount} failed (retrying)` : ''} items\n`);

  const runHeader = [
    `\n${'='.repeat(72)}`,
    `=== EXECUTE RUN: ${new Date().toISOString()} ===`,
    `Flags: --execute` +
      (autoAcceptReview     ? ' --auto-accept-review'      : '') +
      (deleteJunk           ? ' --delete-junk'             : '') +
      (deleteEmptyShells    ? ' --delete-empty-shells'     : '') +
      (forceDeleteAudioJunk ? ' --force-delete-audio-junk' : '') +
      (retryFailed          ? ' --retry-failed'            : ''),
    `Items: ${pendingCount} pending${retryCount ? `, ${retryCount} retrying` : ''}`,
    `${'='.repeat(72)}`,
  ].join('\n');
  fs.appendFileSync(executeLog, runHeader + '\n');

  const relPath = p => path.relative(root, p);

  function logExec(line) {
    console.log(line);
    fs.appendFileSync(executeLog, line + '\n');
  }

  let done = 0, skipped = 0, failed = 0;

  for (const item of toProcess) {
    if (!statOf(item.source)) {
      item.status = 'skipped'; item.error = 'source no longer exists'; skipped++;
      fs.appendFileSync(executeLog, `SKIP   (gone)   ${relPath(item.source)}\n`);
      writePlan(planFile, plan);
      continue;
    }

    let dest = item.dest;
    if (item.bestGuess) dest = autoAcceptReview ? item.dest : item.fallbackDest;

    if (item.junk) {
      if (deleteJunk) {
        try {
          deleteItem(item.source, root, forceDeleteAudioJunk);
          logExec(`DONE   deleted  ${relPath(item.source)}`);
          item.status = 'done'; delete item.error; done++;
        } catch (e) {
          logExec(`FAIL   delete   ${relPath(item.source)}: ${e.message}`);
          item.status = 'failed'; item.error = e.message; failed++;
        }
      } else if (item.action === 'move' && dest) {
        try {
          const r = safeMove(item.source, dest, root);
          if (r === 'SKIP_EXISTS') {
            logExec(`SKIP   exists   ${relPath(dest)}`);
            item.status = 'skipped'; skipped++;
          } else {
            logExec(`DONE   ${r.padEnd(7)} ${relPath(item.source)} → ${relPath(dest)}`);
            item.status = 'done'; delete item.error; done++;
          }
        } catch (e) {
          logExec(`FAIL   move     ${relPath(item.source)}: ${e.message}`);
          item.status = 'failed'; item.error = e.message; failed++;
        }
      } else {
        item.status = 'skipped'; skipped++;
      }
      writePlan(planFile, plan);
      continue;
    }

    if (!dest) {
      item.status = 'skipped'; skipped++;
      fs.appendFileSync(executeLog, `SKIP   no-dest  ${relPath(item.source)}\n`);
      writePlan(planFile, plan);
      continue;
    }

    try {
      const r = safeMove(item.source, dest, root);
      if (r === 'SKIP_EXISTS') {
        logExec(`SKIP   exists   ${relPath(dest)}`);
        item.status = 'skipped'; skipped++;
      } else {
        logExec(`DONE   ${r.padEnd(7)} ${relPath(item.source)} → ${relPath(dest)}`);
        item.status = 'done'; delete item.error; done++;
      }
    } catch (e) {
      logExec(`FAIL   move     ${relPath(item.source)}: ${e.message}`);
      item.status = 'failed'; item.error = e.message; failed++;
    }
    writePlan(planFile, plan);
  }

  const summary = `\n--- SUMMARY: ${done} done, ${skipped} skipped, ${failed} failed ---`;
  logExec(summary);
  fs.appendFileSync(executeLog, '\n');

  if (deleteEmptyShells) {
    console.log('\n[Cleaning empty shells...]');
    fs.appendFileSync(executeLog, '[Cleaning empty shells...]\n');
    for (const e of listDir(root).sort()) {
      const p = path.join(root, e);
      if (statOf(p)?.isDirectory() && !HARD_SKIP.has(e) && !e.startsWith('.'))
        cleanEmptyShells(p, 1, { root, executeLog });
    }
  }

  if (failed > 0)
    console.log(`\nSome items failed. Check execute.log for details.\nRe-run with --execute --retry-failed to retry them.`);
  console.log(`Execute log: ${executeLog}`);
  console.log('Done.');
}
