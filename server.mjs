// SakugaTV: local server that serves the page and proxies the Sakugabooru API
// (the API sends no CORS headers, so the browser can't read the JSON directly).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, PRESET_VERSION, EXTRA_CATEGORY } from './presets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const PORT = Number(process.env.PORT || 8765);
const BOORU = 'https://www.sakugabooru.com';
const UA = 'SakugaTV/1.0 (uso pessoal)';
const TAG_LIMIT = 6; // a busca do site recusa mais de 6 tags comuns (metatags não contam)
const BATCH = 40;

const DEFAULT_STATE = {
  channels: PRESETS,
  presetVersion: PRESET_VERSION,
  // hidden on every channel (the umbrella tag covers films and seasons)
  blocked: ['looney_tunes', 'tom_&_jerry', 'steven_universe', 'the_simpsons', 'adventure_time', 'avatar_series', 'one_piece'],
  favorites: [],
  seen: [],
  lastChannel: 'top',
};

let lastGood = null;
function readState() {
  let state;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '');
    const saved = JSON.parse(raw);
    state = { ...structuredClone(DEFAULT_STATE), ...saved, presetVersion: saved.presetVersion || 0 };
  } catch (e) {
    // mid-write the file disappears for an instant; fall back to the last state read
    if (e.code !== 'ENOENT' || lastGood) return structuredClone(lastGood || DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
  // new presets join the end of their group; channels the user edited or deleted don't come back
  if ((state.presetVersion || 0) < PRESET_VERSION) {
    const known = new Set(state.knownPresets || state.channels.map((c) => c.id));
    for (const c of state.channels) {
      const p = PRESETS.find((x) => x.id === c.id);
      if (!p) continue;
      if (!c.group) c.group = p.group;
      if (p.extra) c.extra = true;
      // presets whose tags weren't edited get the freshly measured minimum score
      if (c.include.join() === p.include.join()) c.minScore = p.minScore;
    }
    for (const p of PRESETS) if (!known.has(p.id) && !state.channels.some((c) => c.id === p.id)) state.channels.push(structuredClone(p));
    state.presetVersion = PRESET_VERSION;
  }
  // post counts always come from preset-stats.json; the guide sorts by them
  for (const c of state.channels) { const p = PRESETS.find((x) => x.id === c.id); if (p?.posts != null) c.posts = p.posts; if (p?.name_en) c.name_en = p.name_en; }
  state.knownPresets = PRESETS.map((p) => p.id);
  lastGood = state;
  return state;
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  // Windows sometimes holds the file for an instant
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, STATE_FILE); return; } catch (e) { if (i === 4) throw e; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

async function booru(pathAndQuery) {
  const res = await fetch(BOORU + pathAndQuery, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`sakugabooru respondeu ${res.status}`);
  return res.json();
}

const clean = (list) => (Array.isArray(list) ? list : String(list || '').split(','))
  .map((t) => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);

async function getPosts(params) {
  const include = clean(params.get('include')).slice(0, TAG_LIMIT);
  // a channel that asks for a hidden tag on purpose gets it back
  const blocked = clean(readState().blocked).filter((t) => !include.includes(t));
  const exclude = [...new Set([...clean(params.get('exclude')), ...blocked])];
  const minScore = Number(params.get('minScore') || 0);
  const order = params.get('order') === 'score' ? 'order:score' : 'order:random';
  const page = Number(params.get('page') || 1);

  // exclusions take the remaining slots; the rest is filtered here
  const slots = TAG_LIMIT - include.length;
  const sent = exclude.slice(0, slots);
  const local = exclude.slice(slots);
  const tags = [order, minScore > 0 ? `score:>=${minScore}` : '', ...include, ...sent.map((t) => '-' + t)]
    .filter(Boolean).join(' ');

  const q = new URLSearchParams({ api_version: '2', include_tags: '1', limit: String(BATCH), page: String(page), tags });
  const data = await booru('/post.json?' + q);
  const posts = (data.posts || [])
    .filter((p) => ['mp4', 'webm'].includes(p.file_ext) && p.is_shown_in_index !== false && p.status === 'active')
    .filter((p) => { const t = p.tags.split(' '); return !local.some((x) => t.includes(x)); })
    .map((p) => ({
      id: p.id, file: p.file_url, preview: p.preview_url, score: p.score,
      source: p.source, tags: p.tags.split(' '), width: p.width, height: p.height,
      author: p.author, created: p.created_at, size: p.file_size,
    }));
  return { posts, tagTypes: data.tags || {}, rawCount: (data.posts || []).length, query: tags };
}

// channel thumbnail for the guide: a top-scored clip of the filter, cached on disk for 14 days.
// Requests to Sakugabooru go out one at a time, so the guide never fires 200 calls at once.
const THUMBS_FILE = path.join(ROOT, 'data', 'thumbs.json');
let thumbs = {};
try { thumbs = JSON.parse(fs.readFileSync(THUMBS_FILE, 'utf8')); } catch {}
let thumbChain = Promise.resolve();
let thumbSaveTimer;
async function getThumb(params) {
  const include = clean(params.get('include')).slice(0, TAG_LIMIT);
  const exclude = clean(params.get('exclude'));
  const key = [...include].sort().join(' ') + ' | ' + [...exclude].sort().join(' ');
  const hit = thumbs[key];
  if (hit && Date.now() - hit.ts < 14 * 864e5) return hit;
  const job = thumbChain.then(async () => {
    if (thumbs[key] && Date.now() - thumbs[key].ts < 14 * 864e5) return thumbs[key];
    const tags = ['order:score', ...include, ...exclude.slice(0, TAG_LIMIT - include.length).map((t) => '-' + t)].join(' ');
    const list = await booru('/post.json?' + new URLSearchParams({ limit: '12', tags })).catch(() => []);
    // one of the top clips, picked by the key: similar channels don't repeat the same cover
    const blocked = clean(readState().blocked).filter((t) => !include.includes(t));
    const ok = list.filter((x) => ['mp4', 'webm'].includes(x.file_ext) && x.is_shown_in_index !== false && !x.tags.split(' ').some((t) => blocked.includes(t)));
    const pool = ok.length ? ok : list;
    let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const p = pool[h % Math.max(1, pool.length)];
    thumbs[key] = { preview: p ? p.preview_url : null, ts: Date.now() };
    clearTimeout(thumbSaveTimer);
    thumbSaveTimer = setTimeout(() => { try { fs.writeFileSync(THUMBS_FILE, JSON.stringify(thumbs)); } catch {} }, 2000);
    await new Promise((r) => setTimeout(r, 250));
    return thumbs[key];
  });
  thumbChain = job.catch(() => {});
  return job;
}

async function getTags(params) {
  const q = clean(params.get('q'))[0];
  if (!q) return [];
  const list = await booru('/tag.json?' + new URLSearchParams({ name: q, limit: '12', order: 'count' }));
  const types = { 0: 'geral', 1: 'animador', 3: 'anime', 4: 'personagem', 5: 'estúdio', 6: 'meta' };
  return list.map((t) => ({ name: t.name, count: t.count, type: types[t.type] || 'geral' }));
}

const MIME = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, app: 'sakugatv' });
    if (url.pathname === '/api/posts') return send(res, 200, await getPosts(url.searchParams));
    if (url.pathname === '/api/tags') return send(res, 200, await getTags(url.searchParams));
    if (url.pathname === '/api/config') return send(res, 200, { extraCategory: EXTRA_CATEGORY });
    if (url.pathname === '/api/thumb') return send(res, 200, await getThumb(url.searchParams));
    if (url.pathname === '/api/state') {
      if (req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const state = JSON.parse(body);
        state.seen = (state.seen || []).slice(-5000);
        writeState(state);
        return send(res, 200, { ok: true });
      }
      return send(res, 200, readState());
    }
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { erro: 'não achei' });
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 502, { erro: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SakugaTV em http://localhost:${PORT}`);
  // warm up the guide thumbnails in the background (cached ones don't hit the site)
  setTimeout(async () => {
    for (const c of readState().channels) await getThumb(new URLSearchParams({ include: c.include.join(','), exclude: c.exclude.join(',') })).catch(() => {});
  }, 3000);
});
