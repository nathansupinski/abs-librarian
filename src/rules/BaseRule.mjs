/**
 * Base class for all scanner rules.
 *
 * Rules are auto-loaded from src/rules/ at scan start. Any .mjs file with a
 * default export class extending ScanRule is automatically included.
 *
 * The RuleContext passed to each hook provides:
 *   addMove, addJunkMove, addJunkDelete, addBestGuess, addSkip,
 *   addDuplicate, addGroupDuplicate, addLookup    — plan state mutators
 *   root, relPath, checkIgnore, options            — read-only config
 *   listDir, statOf, isAudio, isSystemFile,
 *   isJunkFile, hasAudioRecursive, isDoubleNested  — fs helpers
 *   readTags, recommendDuplicate, searchOpenLibrary — metadata helpers
 *   scanBookForJunk(bookPath, bookName, authorName, recursive) — shared sub-routine
 */
export class ScanRule {
  /** Unique identifier used in lookup logs. Defaults to class name. */
  get name() { return this.constructor.name; }

  /**
   * Execution priority. Lower numbers run first.
   * Rules with the same priority run in filename-alphabetical order.
   */
  get priority() { return 100; }

  /**
   * Called for each book-level directory inside an author dir.
   * Return true to signal the directory was fully handled (stops the rule chain).
   * Return false to pass to the next rule (or the scanner default).
   *
   * @param {string}   bookPath   Absolute path to the book directory
   * @param {string}   bookName   Directory basename
   * @param {string}   authorName Parent directory basename (author name)
   * @param {string}   authorPath Absolute path to the author directory
   * @param {object}   ctx        RuleContext
   */
  async onBookDir(bookPath, bookName, authorName, authorPath, ctx) { return false; }

  /**
   * Called for each author-level directory before the default child iteration.
   * Return true to replace the scanner's default author processing entirely.
   * (Rare — only needed when the entire author dir structure is non-standard.)
   *
   * @param {string} authorPath Absolute path to the author directory
   * @param {string} authorName Directory basename
   * @param {object} ctx        RuleContext
   */
  async onAuthorDir(authorPath, authorName, ctx) { return false; }
}
