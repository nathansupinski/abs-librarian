import fs from 'fs';
import path from 'path';
import { HARD_SKIP, AUDIO_EXTS, JUNK_EXTS, SYSTEM_NAMES } from './constants.mjs';

export function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }
export function statOf(p)  { try { return fs.statSync(p); }   catch { return null; } }

export function isAudio(n)      { return AUDIO_EXTS.has(path.extname(n)); }
export function isSystemFile(n) { return SYSTEM_NAMES.has(n) || n.startsWith('._'); }
export function isJunkFile(n)   { return JUNK_EXTS.has(path.extname(n)); }

export function hasAudioRecursive(dir) {
  for (const e of listDir(dir)) {
    if (isAudio(e)) return true;
    const p = path.join(dir, e);
    if (statOf(p)?.isDirectory() && !e.startsWith('.') && !HARD_SKIP.has(e))
      if (hasAudioRecursive(p)) return true;
  }
  return false;
}

export function isDoubleNested(dirPath) {
  const name = path.basename(dirPath);
  const entries = listDir(dirPath).filter(e => !isSystemFile(e) && !e.startsWith('.'));
  const dirs   = entries.filter(e => statOf(path.join(dirPath, e))?.isDirectory());
  const audios = entries.filter(e => isAudio(e));
  return dirs.length === 1 && dirs[0] === name && audios.length === 0;
}

export function copyTree(src, dest) {
  const s = statOf(src);
  if (!s) throw new Error(`Source missing: ${src}`);
  if (s.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of listDir(src)) copyTree(path.join(src, e), path.join(dest, e));
  } else {
    fs.copyFileSync(src, dest);
  }
}

export function verifyTree(src, dest) {
  const ss = statOf(src), ds = statOf(dest);
  if (!ds) throw new Error(`Copy missing: ${dest}`);
  if (ss.isDirectory()) {
    for (const e of listDir(src)) verifyTree(path.join(src, e), path.join(dest, e));
  } else if (ss.size !== ds.size) {
    throw new Error(`Size mismatch: ${src} (${ss.size}) vs ${dest} (${ds.size})`);
  }
}

export function removeTree(p, root) {
  if (!p.startsWith(root + '/')) throw new Error(`Safety: will not remove outside ROOT: ${p}`);
  const s = statOf(p);
  if (!s) return;
  if (s.isDirectory()) {
    for (const e of listDir(p)) removeTree(path.join(p, e), root);
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

export function safeMove(src, dest, root) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (statOf(dest)) return 'SKIP_EXISTS';

  // Cannot rename a directory into a subdirectory of itself (EINVAL).
  // Shuffle via sibling temp dir.
  if (dest.startsWith(src + '/') || dest.startsWith(src + path.sep)) {
    const tmp = src + '__reorg_tmp';
    if (statOf(tmp)) throw new Error(`Temp path already exists: ${tmp}`);
    fs.renameSync(src, tmp);
    try {
      fs.mkdirSync(src, { recursive: true });
      try { fs.renameSync(tmp, dest); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        copyTree(tmp, dest); verifyTree(tmp, dest); removeTree(tmp, root);
      }
    } catch (e) {
      try { if (!statOf(src + path.sep + path.basename(dest))) fs.renameSync(tmp, src); } catch {}
      throw e;
    }
    return 'renamed';
  }

  try { fs.renameSync(src, dest); return 'renamed'; }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyTree(src, dest); verifyTree(src, dest); removeTree(src, root);
    return 'copied';
  }
}

export function deleteItem(p, root, forceDeleteAudioJunk = false) {
  if (!p.startsWith(root + '/')) throw new Error(`Safety: will not delete outside ROOT: ${p}`);
  const base = path.basename(p);
  const isMacResourceFork = base.startsWith('._');
  if (!isMacResourceFork && isAudio(base) && !forceDeleteAudioJunk)
    throw new Error(`Safety: refusing to delete audio file: ${p}`);
  removeTree(p, root);
}

export function cleanEmptyShells(dir, depth, { root, executeLog, hardSkip = HARD_SKIP }) {
  if (hardSkip.has(path.basename(dir)) || !statOf(dir)?.isDirectory()) return;
  const entries = listDir(dir);
  for (const e of entries) {
    const p = path.join(dir, e);
    if (statOf(p)?.isDirectory()) cleanEmptyShells(p, depth + 1, { root, executeLog, hardSkip });
  }
  if (depth === 0) return; // never delete ROOT
  if (!hasAudioRecursive(dir)) {
    const remaining = listDir(dir);
    if (remaining.every(e => isSystemFile(e) || isJunkFile(e) || e.startsWith('.'))) {
      try {
        for (const e of remaining) {
          const p = path.join(dir, e);
          if (statOf(p)?.isFile()) fs.unlinkSync(p);
        }
        fs.rmdirSync(dir);
        const msg = `DONE   deleted  ${path.relative(root, dir)} (empty shell)`;
        console.log(msg);
        if (executeLog) fs.appendFileSync(executeLog, msg + '\n');
      } catch (e) {
        const msg = `FAIL   delete   ${path.relative(root, dir)}: ${e.message}`;
        console.log(msg);
        if (executeLog) fs.appendFileSync(executeLog, msg + '\n');
      }
    }
  }
}
