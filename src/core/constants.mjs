export const HARD_SKIP = new Set(['_NeedsReview', '_non-audiobook', '.claude']);

export const NON_AUDIOBOOK_DIRS = new Set(['Aaptiv']);

export const AUDIO_EXTS = new Set([
  '.mp3', '.MP3', '.m4b', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.WMA', '.oldmp3',
]);

export const JUNK_EXTS = new Set([
  '.url', '.URL', '.nzb', '.sfv', '.md5', '.nfo', '.NFO', '.db', '.cue', '.1',
]);

export const SYSTEM_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'thumbs.db', '._.DS_Store', 'desktop.ini',
]);

