// Collaborative Markdown editor server.
// Serves the editor UI and a small JSON API over a folder of real .md files.
// Comments and version history live next to the docs in <root>/.collab/.
//
//   node server.js [docs-root]      (default: ./workspace)
import http from 'node:http';
import fs from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3458;
const ROOT = path.resolve(process.argv[2] || process.env.DOCS_ROOT || path.join(HERE, 'workspace'));
const COLLAB = path.join(ROOT, '.collab');
const APP_DIR = path.join(HERE, 'app');
const SKIP_DIRS = new Set(['.collab', '.git', 'node_modules', 'dist', 'build', '.next', 'vendor']);
const DOC_EXT = /\.(md|markdown)$/i;

// ---------- Paths ----------

function docPath(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw httpError(400, 'path is required');
  const clean = rel.replace(/^\/+/, '');
  if (!DOC_EXT.test(clean)) throw httpError(400, 'Only .md / .markdown files are supported');
  const abs = path.resolve(ROOT, clean);
  if (!abs.startsWith(ROOT + path.sep) || abs.startsWith(COLLAB + path.sep)) throw httpError(400, 'Path is outside the docs folder');
  return { rel: path.relative(ROOT, abs).split(path.sep).join('/'), abs };
}
const metaFile = (rel) => path.join(COLLAB, 'docs', `${rel}.json`);
const versionFile = (rel, id) => path.join(COLLAB, 'versions', rel, `${id}.md`);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- Doc metadata (versions + comment threads), cached in memory ----------

const metas = new Map(); // rel -> { versions: [], threads: [] }
const locks = new Map(); // rel -> promise chain, serialises writes per doc

function withLock(rel, fn) {
  const prev = locks.get(rel) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(rel, next.catch(() => {}));
  return next;
}

async function loadMeta(rel) {
  if (metas.has(rel)) return metas.get(rel);
  let meta;
  try {
    meta = JSON.parse(await readFile(metaFile(rel), 'utf8'));
  } catch {
    meta = { versions: [], threads: [] };
  }
  delete meta.writer; // (older single-writer field, no longer used)
  metas.set(rel, meta);
  return meta;
}

async function saveMeta(rel) {
  await mkdir(path.dirname(metaFile(rel)), { recursive: true });
  await writeFile(metaFile(rel), JSON.stringify(metas.get(rel), null, 2));
}

async function readDoc(abs) {
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const latest = (meta) => meta.versions[meta.versions.length - 1] || null;

// Automatic pen: Claude's edits wait until the user has paused typing in that doc
const QUIET_MS = 3000;
const MAX_WAIT_MS = 30_000;
const typingAt = new Map(); // rel -> last time the user typed or saved

function userTyped(rel) {
  typingAt.set(rel, Date.now());
}

async function waitForQuiet(rel) {
  const deadline = Date.now() + MAX_WAIT_MS;
  let announced = false;
  while (Date.now() - (typingAt.get(rel) || 0) < QUIET_MS) {
    if (!announced) {
      broadcast('claude_waiting', { path: rel });
      announced = true;
    }
    if (Date.now() > deadline) throw httpError(409, 'The user is still typing in this document. Try the edit again in a few seconds.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const COALESCE_MS = 5 * 60_000;

async function versionContent(rel, id) {
  return readFile(versionFile(rel, id), 'utf8');
}

// Record `content` as a new version (caller holds the lock). Skips if unchanged.
async function addVersion(rel, content, { author, message, threadId, coalesce }) {
  const meta = await loadMeta(rel);
  const last = latest(meta);
  if (last && (await versionContent(rel, last.id).catch(() => null)) === content) return last;
  // Autosaves from one typing session fold into a single version
  if (coalesce && last && last.id > 1 && last.author === author && last.coalesce && Date.now() - new Date(last.at) < COALESCE_MS) {
    await writeFile(versionFile(rel, last.id), content);
    Object.assign(last, { at: new Date().toISOString(), size: content.length });
    await saveMeta(rel);
    return last;
  }
  const v = {
    id: (last?.id || 0) + 1,
    author,
    message: message || '',
    at: new Date().toISOString(),
    size: content.length,
    ...(threadId && { thread_id: threadId }),
    ...(coalesce && { coalesce: true }),
  };
  await mkdir(path.dirname(versionFile(rel, v.id)), { recursive: true });
  await writeFile(versionFile(rel, v.id), content);
  meta.versions.push(v);
  await saveMeta(rel);
  return v;
}

// Make sure the doc's current file content is captured as a version.
async function ensureTracked(rel, abs) {
  const content = await readDoc(abs);
  if (content === null) throw httpError(404, `No such document: ${rel}`);
  const meta = await loadMeta(rel);
  if (!meta.versions.length) await addVersion(rel, content, { author: 'initial', message: 'First tracked version' });
  return content;
}

async function writeDoc(rel, abs, content, info) {
  ignoreWatch.set(abs, content);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  const v = await addVersion(rel, content, info);
  broadcast('doc_changed', { path: rel, version: v.id, author: v.author, message: v.message, thread_id: info.threadId || null });
  return v;
}

async function listDocs() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 500) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
      } else if (DOC_EXT.test(e.name)) {
        out.push(path.relative(ROOT, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  }
  await walk(ROOT);
  out.sort();
  return Promise.all(
    out.map(async (rel) => {
      const meta = await loadMeta(rel);
      return { path: rel, open_threads: meta.threads.filter((t) => t.status === 'open').length, pending: meta.threads.filter(needsClaude).length };
    }),
  );
}

// ---------- Threads ----------

// A thread waits for Claude when the user spoke last
const needsClaude = (t) => t.status === 'open' && t.messages[t.messages.length - 1]?.author === 'you';

function publicThread(t, rel) {
  return { ...t, path: rel };
}

async function findThread(rel, id) {
  const meta = await loadMeta(rel);
  const t = meta.threads.find((x) => x.id === id);
  if (!t) throw httpError(404, `No thread ${id} in ${rel}`);
  return t;
}

// ---------- Presence + long-poll for Claude ----------

let lastHumanActivity = Date.now();
let lastClaudeActivity = 0;
let waiters = [];

// wake=true only for comment activity, so plain saves don't wake a listening Claude
function humanActed(wake = false) {
  lastHumanActivity = Date.now();
  if (wake) for (const w of waiters.slice()) w();
}
function claudeActed() {
  lastClaudeActivity = Date.now();
  broadcastPresence();
}
function presence() {
  return { listening: waiters.length > 0, last_claude_at: lastClaudeActivity || null };
}
function broadcastPresence() {
  broadcast('presence', presence());
}

async function allPending() {
  // Make sure metadata for every doc is loaded (threads can live in any doc)
  await listDocs();
  const out = [];
  for (const [rel, meta] of metas) for (const t of meta.threads) if (needsClaude(t)) out.push({ rel, t });
  return out;
}

async function takePending() {
  const pending = await allPending();
  const touched = new Set();
  for (const { rel, t } of pending) {
    if (!t.claude_working) {
      t.claude_working = true;
      touched.add(rel);
    }
  }
  for (const rel of touched) {
    await saveMeta(rel);
    broadcast('threads_changed', { path: rel });
  }
  return pending.map(({ rel, t }) => publicThread(t, rel));
}

async function waitForPending(timeoutSec) {
  claudeActed();
  let threads = await takePending();
  if (!threads.length && timeoutSec > 0) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters = waiters.filter((w) => w !== done);
        broadcastPresence();
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutSec, 300) * 1000);
      waiters.push(done);
      broadcastPresence();
    });
    // Give a just-posted comment a moment to be saved before collecting
    await new Promise((r) => setTimeout(r, 50));
    threads = await takePending();
  }
  claudeActed();
  return threads.length ? { threads } : { threads: [], idle_seconds: Math.round((Date.now() - lastHumanActivity) / 1000) };
}

// ---------- Live updates (SSE) ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- Edits ----------

function applyEdits(content, edits) {
  let out = content;
  edits.forEach((e, i) => {
    if (typeof e.old_text !== 'string' || typeof e.new_text !== 'string') throw httpError(400, `edits[${i}] needs old_text and new_text`);
    if (e.old_text === '') throw httpError(400, `edits[${i}].old_text is empty; use write_document to replace the whole doc`);
    const count = out.split(e.old_text).length - 1;
    if (count === 0) throw httpError(409, `edits[${i}].old_text was not found. Re-read the document and copy the text exactly.`);
    if (count > 1 && !e.replace_all) throw httpError(409, `edits[${i}].old_text matches ${count} places. Include more surrounding text, or set replace_all.`);
    out = e.replace_all ? out.split(e.old_text).join(e.new_text) : out.replace(e.old_text, () => e.new_text);
  });
  return out;
}

// ---------- Watch for changes made outside the editor (e.g. Claude's Edit tool, git) ----------

const ignoreWatch = new Map(); // abs -> content we just wrote
const watchTimers = new Map();

function startWatcher() {
  try {
    fs.watch(ROOT, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join('/');
      if (rel.startsWith('.collab/') || rel.split('/').some((p) => SKIP_DIRS.has(p))) return;
      if (!DOC_EXT.test(rel)) return;
      clearTimeout(watchTimers.get(rel));
      watchTimers.set(
        rel,
        setTimeout(() => onExternalChange(rel).catch((err) => console.error('watch:', err.message)), 250),
      );
    });
  } catch (err) {
    console.warn('File watching unavailable:', err.message);
  }
}

async function onExternalChange(rel) {
  const { abs } = docPath(rel);
  const content = await readDoc(abs);
  if (content === null) return broadcast('docs_changed', {});
  if (ignoreWatch.get(abs) === content) return;
  ignoreWatch.delete(abs);
  await withLock(rel, async () => {
    const meta = await loadMeta(rel);
    const isNew = !meta.versions.length;
    const v = await addVersion(rel, content, { author: isNew ? 'initial' : 'external', message: isNew ? 'First tracked version' : 'Changed outside the editor' });
    broadcast('doc_changed', { path: rel, version: v.id, author: v.author, message: v.message });
    if (isNew) broadcast('docs_changed', {});
  });
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const author = (a) => (a === 'claude' ? 'claude' : 'you');

const routes = {
  'GET /api/docs': async () => ({ root: ROOT, docs: await listDocs() }),

  'GET /api/doc': async (q) => {
    const { rel, abs } = docPath(q.get('path'));
    const content = await withLock(rel, () => ensureTracked(rel, abs));
    const meta = await loadMeta(rel);
    return { path: rel, content, version: latest(meta).id, versions: meta.versions, threads: meta.threads };
  },

  'PUT /api/doc': async (_q, b) => {
    const { rel, abs } = docPath(b.path);
    const who = author(b.author);
    if (who === 'you') userTyped(rel);
    else await waitForQuiet(rel);
    return withLock(rel, async () => {
      const exists = (await readDoc(abs)) !== null;
      if (exists) await ensureTracked(rel, abs);
      const meta = await loadMeta(rel);
      if (b.base_version && latest(meta) && latest(meta).id !== b.base_version) {
        throw Object.assign(httpError(409, `The document changed since version ${b.base_version} (now v${latest(meta).id}).`), {
          extra: { latest_version: latest(meta).id },
        });
      }
      const v = await writeDoc(rel, abs, String(b.content ?? ''), { author: who, message: b.message || (exists ? 'Edited' : 'Created'), coalesce: Boolean(b.coalesce) });
      if (!exists) broadcast('docs_changed', {});
      who === 'claude' ? claudeActed() : humanActed();
      return { path: rel, version: v.id };
    });
  },

  'POST /api/edit': async (_q, b) => {
    const { rel, abs } = docPath(b.path);
    if (!Array.isArray(b.edits) || !b.edits.length) throw httpError(400, 'edits must be a non-empty array');
    if (author(b.author) === 'claude') await waitForQuiet(rel);
    else userTyped(rel);
    return withLock(rel, async () => {
      const before = await ensureTracked(rel, abs);
      const after = applyEdits(before, b.edits);
      const v = await writeDoc(rel, abs, after, { author: author(b.author), message: b.message || 'Edited', threadId: b.thread_id });
      author(b.author) === 'claude' ? claudeActed() : humanActed();
      return { path: rel, version: v.id, previous_version: v.id - 1 };
    });
  },

  'GET /api/version': async (q) => {
    const { rel } = docPath(q.get('path'));
    const id = Number(q.get('id'));
    return { path: rel, id, content: await versionContent(rel, id).catch(() => { throw httpError(404, `No version ${id}`); }) };
  },

  'POST /api/revert': async (_q, b) => {
    const { rel, abs } = docPath(b.path);
    if (author(b.author) === 'claude') await waitForQuiet(rel);
    return withLock(rel, async () => {
      await ensureTracked(rel, abs);
      const content = await versionContent(rel, Number(b.version_id)).catch(() => { throw httpError(404, `No version ${b.version_id}`); });
      const v = await writeDoc(rel, abs, content, { author: author(b.author), message: `Reverted to v${b.version_id}` });
      author(b.author) === 'claude' ? claudeActed() : humanActed();
      return { path: rel, version: v.id };
    });
  },

  'POST /api/threads': async (_q, b) => {
    const { rel, abs } = docPath(b.path);
    if (!String(b.text || '').trim()) throw httpError(400, 'text is required');
    return withLock(rel, async () => {
      await ensureTracked(rel, abs);
      const meta = await loadMeta(rel);
      const who = author(b.author);
      const thread = {
        id: randomUUID().slice(0, 8),
        anchor: b.anchor && b.anchor.quote ? { quote: b.anchor.quote, prefix: b.anchor.prefix || '', suffix: b.anchor.suffix || '' } : null,
        status: 'open',
        created_at: new Date().toISOString(),
        messages: [{ author: who, text: String(b.text), at: new Date().toISOString() }],
      };
      meta.threads.push(thread);
      await saveMeta(rel);
      broadcast('threads_changed', { path: rel });
      who === 'claude' ? claudeActed() : humanActed(true);
      return publicThread(thread, rel);
    });
  },

  'POST /api/threads/reply': async (_q, b) => {
    const { rel } = docPath(b.path);
    if (!String(b.text || '').trim()) throw httpError(400, 'text is required');
    return withLock(rel, async () => {
      const t = await findThread(rel, b.thread_id);
      const who = author(b.author);
      t.messages.push({ author: who, text: String(b.text), at: new Date().toISOString() });
      if (who === 'you' && t.status === 'resolved') t.status = 'open';
      if (who === 'claude') {
        delete t.claude_working;
        if (b.resolve) t.status = 'resolved';
      }
      await saveMeta(rel);
      broadcast('threads_changed', { path: rel });
      who === 'claude' ? claudeActed() : humanActed(true);
      return publicThread(t, rel);
    });
  },

  'POST /api/threads/status': async (_q, b) => {
    const { rel } = docPath(b.path);
    if (!['open', 'resolved'].includes(b.status)) throw httpError(400, 'status must be open or resolved');
    return withLock(rel, async () => {
      const t = await findThread(rel, b.thread_id);
      t.status = b.status;
      delete t.claude_working;
      await saveMeta(rel);
      broadcast('threads_changed', { path: rel });
      author(b.author) === 'claude' ? claudeActed() : humanActed(b.status === 'open');
      return publicThread(t, rel);
    });
  },

  'POST /api/threads/delete': async (_q, b) => {
    const { rel } = docPath(b.path);
    return withLock(rel, async () => {
      const meta = await loadMeta(rel);
      meta.threads = meta.threads.filter((t) => t.id !== b.thread_id);
      await saveMeta(rel);
      broadcast('threads_changed', { path: rel });
      return { ok: true };
    });
  },

  'GET /api/threads': async (q) => {
    const status = q.get('status');
    const only = q.get('path') ? docPath(q.get('path')).rel : null;
    await listDocs();
    const out = [];
    for (const [rel, meta] of metas) {
      if (only && rel !== only) continue;
      for (const t of meta.threads) {
        if (status === 'needs_reply' ? needsClaude(t) : !status || t.status === status) out.push(publicThread(t, rel));
      }
    }
    return { threads: out };
  },

  'GET /api/pending': async (q) => waitForPending(Number(q.get('timeout') ?? 300)),

  'GET /api/presence': async () => presence(),

  // Typing heartbeat from the editor, so Claude's edits wait for a pause
  'POST /api/typing': async (_q, b) => {
    userTyped(docPath(b.path).rel);
    return { ok: true };
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: presence\ndata: ${JSON.stringify(presence())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await route(url.searchParams, body));
      }
      if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
      const file = path.normalize(path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
      const data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
      res.end(data);
    } catch (err) {
      send(res, err.status || 500, { error: err.message, ...(err.extra || {}) });
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Doc editor at http://127.0.0.1:${PORT}`);
    console.log(`Docs folder: ${ROOT}`);
    startWatcher();
  });
