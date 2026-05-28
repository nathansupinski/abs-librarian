import path from 'path';
import { Command } from 'commander';
import { runDryScan } from './core/scanner.mjs';
import { runExecute } from './core/executor.mjs';

export async function runCLI(argv) {
  const program = new Command();

  program
    .name('abs-librarian')
    .description('Reorganizes an Audiobookshelf library to Author/[Series/]Title/audiofiles convention')
    .option('--root <path>', 'Audiobooks root directory', process.env.AUDIOBOOKS_ROOT || '/mnt/user/Audiobooks')
    .option('--ingest <path>', 'Ingestion folder: scan here, move books into --root')
    .option('--execute', 'Apply moves from plan.json')
    .option('--auto-accept-review', 'Use best-guess destinations instead of _NeedsReview/')
    .option('--delete-junk', 'Delete junk/system files and empty dirs')
    .option('--delete-empty-shells', 'Remove dirs containing no audio after all moves')
    .option('--force-delete-audio-junk', 'Bypass audio-extension safety check for junk items')
    .option('--retry-failed', 'Retry items that failed in a previous execute run')
    .option('--ignore-file <path>', 'Gitignore-style file; matched paths are preserved')
    .option('--duplicates-folder <path>', 'Move resolved duplicates here instead of deleting them')
    .option('--scope <substr>', 'Scan only top-level dirs whose name contains this substring (debug)')
    .option('--debug-rules', 'Print verbose rule, provider, and metadata debug output to stdout')
    .allowUnknownOption(false);

  program.parse(argv);
  const opts = program.opts();

  const root = path.resolve(opts.root);
  const ingest = opts.ingest ? path.resolve(opts.ingest) : null;
  if (ingest && ingest === root) {
    console.error('Error: --ingest and --root must be different directories.');
    process.exit(1);
  }
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const planFile   = path.join(scriptDir, '..', 'plan.json');
  const executeLog = path.join(scriptDir, '..', 'execute.log');
  const glossary   = path.join(root, 'REORGANIZATION_GLOSSARY.md');
  const ignoreFile = opts.ignoreFile ?? path.join(ingest ?? root, '.audiobooksignore');

  if (opts.execute) {
    // Read sourceRoot from plan.settings so executor knows ingest-mode roots
    // even when the user re-invokes --execute without --ingest.
    let sourceRoot = null;
    try {
      const plan = JSON.parse(await import('fs').then(m => m.promises.readFile(planFile, 'utf8')));
      if (plan?.settings?.sourceRoot) sourceRoot = plan.settings.sourceRoot;
    } catch { /* plan may not exist yet — runExecute will error cleanly */ }
    await runExecute(planFile, executeLog, root, {
      sourceRoot,
      autoAcceptReview:     !!opts.autoAcceptReview,
      deleteJunk:           !!opts.deleteJunk,
      deleteEmptyShells:    !!opts.deleteEmptyShells,
      forceDeleteAudioJunk: !!opts.forceDeleteAudioJunk,
      retryFailed:          !!opts.retryFailed,
    });
  } else {
    const duplicatesFolder = opts.duplicatesFolder ? path.resolve(opts.duplicatesFolder) : undefined;
    if (opts.debugRules) { process.env.ABS_DEBUG_SERIES = '1'; process.env.ABS_DEBUG = '1'; }
    const scanSource = ingest ?? root;
    const destRoot   = ingest ? root : undefined;
    await runDryScan(scanSource, {
      planFile, glossaryPath: glossary, ignoreFile, duplicatesFolder,
      scope: opts.scope || undefined,
      destRoot,
    });
  }
}
