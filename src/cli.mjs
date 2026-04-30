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
    .option('--execute', 'Apply moves from plan.json')
    .option('--auto-accept-review', 'Use best-guess destinations instead of _NeedsReview/')
    .option('--delete-junk', 'Delete junk/system files and empty dirs')
    .option('--delete-empty-shells', 'Remove dirs containing no audio after all moves')
    .option('--force-delete-audio-junk', 'Bypass audio-extension safety check for junk items')
    .option('--retry-failed', 'Retry items that failed in a previous execute run')
    .option('--ignore-file <path>', 'Gitignore-style file; matched paths are preserved')
    .allowUnknownOption(false);

  program.parse(argv);
  const opts = program.opts();

  const root = path.resolve(opts.root);
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const planFile   = path.join(scriptDir, '..', 'plan.json');
  const executeLog = path.join(scriptDir, '..', 'execute.log');
  const glossary   = path.join(root, 'REORGANIZATION_GLOSSARY.md');
  const ignoreFile = opts.ignoreFile ?? path.join(root, '.audiobooksignore');

  if (opts.execute) {
    await runExecute(planFile, executeLog, root, {
      autoAcceptReview:     !!opts.autoAcceptReview,
      deleteJunk:           !!opts.deleteJunk,
      deleteEmptyShells:    !!opts.deleteEmptyShells,
      forceDeleteAudioJunk: !!opts.forceDeleteAudioJunk,
      retryFailed:          !!opts.retryFailed,
    });
  } else {
    await runDryScan(root, { planFile, glossaryPath: glossary, ignoreFile });
  }
}
