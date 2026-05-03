import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { exec, spawn } from 'child_process';
import { Command } from 'commander';
import express from 'express';
import { readPlan, writePlan } from './core/plan.mjs';
import { readTags, recommendDuplicate } from './core/metadata.mjs';
import { statOf, listDir } from './core/fs-utils.mjs';
import { resolver as metadataResolver } from './providers/index.mjs';
import { cleanBookTitle } from './core/title-utils.mjs';

const ALLOWED_PATCH_FIELDS = new Set(['status', 'dest', 'bestGuess', 'fallbackDest', 'series']);
const ALLOWED_STATUSES     = new Set(['pending', 'approved', 'skipped']);

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start ${url}`
            : process.platform === 'darwin' ? `open ${url}`
            : `xdg-open ${url}`;
  exec(cmd, () => {});
}

// ---- Process runner state (module-level singleton) --------------------

let currentRun = null; // { process, type, output: string[] }
const sseClients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}

function spawnRun(type, scriptPath, args) {
  const proc = spawn(process.execPath, [scriptPath, ...args]);
  currentRun = { process: proc, type, output: [] };
  broadcast({ event: 'start', runType: type });

  const onData = chunk => {
    const text = chunk.toString();
    currentRun?.output.push(text);
    broadcast({ event: 'output', text });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', code => {
    broadcast({ event: 'done', code });
    currentRun = null;
  });
}

export function startServer(argv) {
  const program = new Command();
  program
    .name('gui')
    .option('--port <number>', 'Port to listen on', '7000')
    .option('--no-open', 'Do not open browser automatically')
    .option('--root <path>', 'Audiobooks root directory (used when no plan.json exists yet)')
    .allowUnknownOption(false);
  program.parse(argv);
  const opts = program.opts();

  const PORT       = parseInt(opts.port, 10);
  const scriptDir  = path.dirname(new URL(import.meta.url).pathname);
  const PLAN_FILE  = path.join(scriptDir, '..', 'plan.json');
  const DIST_DIR   = path.join(scriptDir, '..', 'gui-dist');

  // Determine ROOT: prefer plan file, fall back to --root option.
  // Server starts successfully even when neither is available.
  function getRoot() {
    if (statOf(PLAN_FILE)) {
      try {
        const p = readPlan(PLAN_FILE);
        if (p.ignoreFile) return path.dirname(p.ignoreFile);
        if (p.root)       return p.root;
      } catch { /* fall through */ }
    }
    return opts.root ? path.resolve(opts.root) : null;
  }

  const ROOT = getRoot();

  const app = express();
  app.use(express.json());

  // ---- API routes -------------------------------------------------------

  app.get('/api/plan', (_req, res) => {
    if (!statOf(PLAN_FILE)) {
      return res.json({ noPlan: true, root: getRoot() });
    }
    try { res.json(readPlan(PLAN_FILE)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/items/:id', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const item = plan.items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });

      const patch = req.body;
      for (const [k, v] of Object.entries(patch)) {
        if (!ALLOWED_PATCH_FIELDS.has(k)) continue;
        if (k === 'status' && !ALLOWED_STATUSES.has(v)) continue;
        item[k] = v;
      }
      writePlan(PLAN_FILE, plan);
      res.json({ ok: true, item });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/items', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      let updated = 0;

      if (Array.isArray(req.body.items)) {
        // Per-item patch format: { items: [{id, patch}, ...] }
        const itemMap = new Map(plan.items.map(i => [i.id, i]));
        for (const { id, patch } of req.body.items) {
          const item = itemMap.get(id);
          if (!item) continue;
          for (const [k, v] of Object.entries(patch)) {
            if (!ALLOWED_PATCH_FIELDS.has(k)) continue;
            if (k === 'status' && !ALLOWED_STATUSES.has(v)) continue;
            item[k] = v;
          }
          updated++;
        }
      } else {
        // Same-patch format: { ids, patch }
        const { ids, patch } = req.body;
        if (!Array.isArray(ids) || !patch) return res.status(400).json({ error: 'ids and patch required' });
        const idSet = new Set(ids);
        for (const item of plan.items) {
          if (!idSet.has(item.id)) continue;
          for (const [k, v] of Object.entries(patch)) {
            if (!ALLOWED_PATCH_FIELDS.has(k)) continue;
            if (k === 'status' && !ALLOWED_STATUSES.has(v)) continue;
            item[k] = v;
          }
          updated++;
        }
      }

      writePlan(PLAN_FILE, plan);
      res.json({ ok: true, updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/series/suggest', async (req, res) => {
    try {
      const { title, author } = req.query;
      if (!title) return res.status(400).json({ error: 'title required' });
      const result = await metadataResolver.resolve({ title: cleanBookTitle(title), author: author || null });
      if (!result || !result.series?.length) return res.json(null);
      res.json({
        series: result.series,
        provider: result.provider,
        confidence: result.confidence,
        bookTitle: result.title,
        author: result.author,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/duplicate-meta/:index', async (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const dup = plan.duplicates?.[idx];
      if (!dup) return res.status(404).json({ error: 'Duplicate not found' });

      const [m1, m2] = await Promise.all([readTags(dup.f1, true), readTags(dup.f2, true)]);
      const [s1, s2] = [statOf(dup.f1), statOf(dup.f2)];
      const f1Meta = { ...m1, size: s1?.size ?? null };
      const f2Meta = { ...m2, size: s2?.size ?? null };
      res.json({ f1Meta, f2Meta, recommendation: recommendDuplicate(m1, m2, s1, s2) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/settings', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const allowed = new Set(['duplicatesFolder']);
      plan.settings = plan.settings || {};
      for (const [k, v] of Object.entries(req.body)) {
        if (!allowed.has(k)) continue;
        if (v === null || v === '') delete plan.settings[k];
        else plan.settings[k] = v;
      }
      writePlan(PLAN_FILE, plan);
      res.json({ ok: true, settings: plan.settings });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/duplicates/:index', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const dup = plan.duplicates?.[idx];
      if (!dup) return res.status(404).json({ error: 'Duplicate not found' });

      // Dismiss path: user marked this as not actually a duplicate. Clear any
      // prior resolution + synthesized item, set the dismissal flag, return.
      if (req.body?.dismiss) {
        delete dup.resolution;
        dup.dismissed = true;
        plan.items = plan.items.filter(i => i.id !== `DUP${idx}`);
        writePlan(PLAN_FILE, plan);
        return res.json({ ok: true });
      }

      const { keep } = req.body;
      if (keep !== 'f1' && keep !== 'f2') return res.status(400).json({ error: 'keep must be "f1" or "f2"' });
      delete dup.dismissed;

      const discardFile = keep === 'f1' ? dup.f2 : dup.f1;
      const timestamp   = new Date().toISOString();
      const duplicatesFolder = plan.settings?.duplicatesFolder;

      let action, dest;
      if (duplicatesFolder && ROOT) {
        action = 'move';
        dest = path.join(duplicatesFolder, path.relative(ROOT, discardFile));
      } else {
        action = 'delete';
        dest = null;
      }

      dup.resolution = { keep, deleteFile: discardFile, resolvedAt: timestamp };

      // Remove any existing DUP item for this index
      plan.items = plan.items.filter(i => i.id !== `DUP${idx}`);

      plan.items.push({
        id: `DUP${idx}`,
        type: 'MOVE_FILE',
        source: discardFile,
        dest,
        reason: `duplicate resolution — keeping ${keep} file`,
        notes: `Resolved via GUI on ${timestamp}`,
        status: 'pending',
        junk: action === 'delete',
        action,
        bestGuess: false,
      });

      writePlan(PLAN_FILE, plan);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/duplicates/:index/resolution', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const dup = plan.duplicates?.[idx];
      if (!dup) return res.status(404).json({ error: 'Duplicate not found' });

      delete dup.resolution;
      delete dup.dismissed;
      plan.items = plan.items.filter(i => i.id !== `DUP${idx}`);
      writePlan(PLAN_FILE, plan);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/group-duplicates/:index', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const gd = (plan.groupDuplicates || [])[idx];
      if (!gd) return res.status(404).json({ error: 'Group duplicate not found' });

      if (req.body?.dismiss) {
        delete gd.resolution;
        gd.dismissed = true;
        plan.items = plan.items.filter(i => !i.id?.startsWith(`GD${idx}_`));
        writePlan(PLAN_FILE, plan);
        return res.json({ ok: true });
      }

      const { keep } = req.body;
      if (keep !== 'groupA' && keep !== 'groupB') {
        return res.status(400).json({ error: 'keep must be "groupA" or "groupB"' });
      }
      delete gd.dismissed;

      const timestamp = new Date().toISOString();
      gd.resolution = { keep, resolvedAt: timestamp };
      const duplicatesFolder = plan.settings?.duplicatesFolder;

      // Remove any previously synthesized items for this group duplicate
      plan.items = plan.items.filter(i => !i.id?.startsWith(`GD${idx}_`));

      const discard = keep === 'groupA' ? gd.groupB : gd.groupA;
      const keepLabel = keep === 'groupA' ? gd.groupALabel : gd.groupBLabel;

      discard.files.forEach((filePath, fi) => {
        let action, dest;
        if (duplicatesFolder && ROOT) {
          action = 'move';
          dest = path.join(duplicatesFolder, path.relative(ROOT, filePath));
        } else {
          action = 'delete';
          dest = null;
        }
        plan.items.push({
          id: `GD${idx}_${fi}`,
          type: 'MOVE_FILE',
          source: filePath,
          dest,
          reason: `group duplicate resolution — keeping ${keepLabel}`,
          notes: `Resolved via GUI on ${timestamp}`,
          status: 'pending',
          junk: action === 'delete',
          action,
          bestGuess: false,
        });
      });

      writePlan(PLAN_FILE, plan);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/group-duplicates/:index/resolution', (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const gd = (plan.groupDuplicates || [])[idx];
      if (!gd) return res.status(404).json({ error: 'Group duplicate not found' });

      delete gd.resolution;
      delete gd.dismissed;
      plan.items = plan.items.filter(i => !i.id?.startsWith(`GD${idx}_`));
      writePlan(PLAN_FILE, plan);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sample first file in each group; chapter files share encoding so one read
  // is representative without paying the I/O cost of every file in the group.
  app.get('/api/group-duplicate-meta/:index', async (req, res) => {
    try {
      const plan = readPlan(PLAN_FILE);
      const idx = parseInt(req.params.index, 10);
      const gd = (plan.groupDuplicates || [])[idx];
      if (!gd) return res.status(404).json({ error: 'Group duplicate not found' });

      async function sampleGroup(group) {
        const sampleFile = group?.files?.[0];
        if (!sampleFile) return null;
        const tags = await readTags(sampleFile, true);
        return { bitrate: tags.bitrate, codec: tags.codec, duration: tags.duration };
      }
      const [groupAMeta, groupBMeta] = await Promise.all([
        sampleGroup(gd.groupA), sampleGroup(gd.groupB),
      ]);
      res.json({ groupAMeta, groupBMeta });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/fs/ls', (req, res) => {
    try {
      const reqPath = req.query.path;
      if (!reqPath) return res.status(400).json({ error: 'path query param required' });

      // Safety: only allow browsing within ROOT
      if (ROOT && !path.resolve(reqPath).startsWith(ROOT)) {
        return res.status(403).json({ error: 'Path outside ROOT' });
      }

      const entries = listDir(reqPath)
        .map(name => {
          const full = path.join(reqPath, name);
          const s = statOf(full);
          return s ? { name, path: full, isDir: s.isDirectory() } : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({ entries });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Run controls -----------------------------------------------------

  const REORG_SCRIPT = path.join(scriptDir, '..', 'reorganize.mjs');

  app.get('/api/run/status', (_req, res) => {
    res.json({ running: !!currentRun, type: currentRun?.type ?? null });
  });

  app.get('/api/run/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Catch up: send buffered output for any in-progress run
    if (currentRun) {
      const buffered = currentRun.output.join('');
      if (buffered) res.write(`data: ${JSON.stringify({ event: 'output', text: buffered })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'status', running: true, runType: currentRun.type })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ event: 'status', running: false })}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/api/run/dry-run', (req, res) => {
    if (currentRun) return res.status(409).json({ error: 'A run is already in progress' });
    try {
      // root priority: existing plan file → request body → server --root flag
      let root = getRoot();
      if (req.body?.root) root = path.resolve(req.body.root);
      if (!root) return res.status(400).json({ error: 'No root directory configured. Pass { root } in the request body or restart the server with --root.' });
      const args = ['--root', root];
      if (statOf(PLAN_FILE)) {
        try {
          const plan = readPlan(PLAN_FILE);
          if (plan.ignoreFile) args.push('--ignore-file', plan.ignoreFile);
        } catch { /* best-effort */ }
      }
      spawnRun('dry-run', REORG_SCRIPT, args);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/run/execute', (req, res) => {
    if (currentRun) return res.status(409).json({ error: 'A run is already in progress' });
    try {
      const plan = readPlan(PLAN_FILE);
      const root = plan.ignoreFile ? path.dirname(plan.ignoreFile) : getRoot();
      if (!root) return res.status(400).json({ error: 'Cannot determine ROOT from plan.json' });
      const { flags = {} } = req.body || {};
      const args = ['--root', root, '--execute'];
      if (plan.ignoreFile)            args.push('--ignore-file', plan.ignoreFile);
      if (flags.autoAcceptReview)     args.push('--auto-accept-review');
      if (flags.deleteJunk)           args.push('--delete-junk');
      if (flags.deleteEmptyShells)    args.push('--delete-empty-shells');
      if (flags.retryFailed)          args.push('--retry-failed');
      if (flags.forceDeleteAudioJunk) args.push('--force-delete-audio-junk');
      spawnRun('execute', REORG_SCRIPT, args);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/run/cancel', (_req, res) => {
    if (!currentRun) return res.status(409).json({ error: 'No run in progress' });
    currentRun.process.kill('SIGTERM');
    res.json({ ok: true });
  });

  // ---- Static frontend --------------------------------------------------

  if (statOf(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.send(
      `<html><body style="font-family:sans-serif;padding:2rem">
       <h2>abs-librarian GUI</h2>
       <p>Frontend not built yet. Run: <code>npm run build:gui</code></p>
       <p>The API is running. <a href="/api/plan">View plan.json</a></p>
       </body></html>`
    ));
  }

  // ---- Watch plan.json for external changes (CLI dry-runs) ---------------

  let planWatchDebounce = null;
  fs.watch(path.dirname(PLAN_FILE), (eventType, filename) => {
    if (filename !== path.basename(PLAN_FILE)) return;
    clearTimeout(planWatchDebounce);
    planWatchDebounce = setTimeout(() => broadcast({ event: 'plan-updated' }), 300);
  });

  // ---- Start server -----------------------------------------------------

  createServer(app).listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`abs-librarian GUI running at ${url}`);
    console.log(`Plan file: ${PLAN_FILE}`);
    if (opts.open !== false) openBrowser(url);
  });
}
