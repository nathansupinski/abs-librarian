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

export const KNOWN_MISPLACED = {
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
