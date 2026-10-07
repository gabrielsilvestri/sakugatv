// Measures how many posts each preset has on Sakugabooru and picks the minimum score:
// the highest of the preset's own, 100, 50 and 0 that still leaves MIN_POSTS or more.
// Writes preset-stats.json ({ id: { minScore, posts } }). Run after editing presets.mjs:
//   node scripts/medir-presets.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN_POSTS = 300;
const KEEP = new Set(['top']); // channel that exists precisely for its high score
const out = fileURLToPath(new URL('../preset-stats.json', import.meta.url));
fs.existsSync(out) || fs.writeFileSync(out, '{}');
const { RAW_PRESETS, ALL_PRESETS: PRESETS } = await import('../presets.mjs');
const outLocal = fileURLToPath(new URL('../preset-stats.local.json', import.meta.url));
const publicIds = new Set(RAW_PRESETS.map((p) => p.id));

async function count(tags) {
  const q = new URLSearchParams({ limit: '1', tags: tags.join(' ') });
  for (let i = 0; i < 3; i++) {
    const res = await fetch('https://www.sakugabooru.com/post.xml?' + q, { headers: { 'User-Agent': 'SakugaTV/1.0 (uso pessoal)' } });
    const m = (await res.text()).match(/<posts count="(\d+)"/);
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return 0;
}

// without --all, only presets missing from preset-stats.json are measured
const ALL = process.argv.includes('--all');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const stats = ALL ? {} : { ...readJson(outLocal), ...readJson(out) };
for (const p of PRESETS) {
  if (!ALL && stats[p.id]) continue;
  const base = [...p.include, ...p.exclude.map((t) => '-' + t)];
  const tries = KEEP.has(p.id) ? [p.minScore] : [...new Set([p.minScore, 100, 50, 0])].filter((s) => s <= p.minScore).sort((a, b) => b - a);
  let chosen = tries[tries.length - 1], posts = 0;
  for (const s of tries) {
    posts = await count(s > 0 ? [...base, `score:>=${s}`] : base);
    await new Promise((r) => setTimeout(r, 300));
    chosen = s;
    if (posts >= MIN_POSTS) break;
  }
  stats[p.id] = { minScore: chosen, posts };
  process.stdout.write(`${p.id}:${chosen}/${posts} `);
}
// public presets go to preset-stats.json; the rest (presets.local.mjs) to the local file
const pick = (keep) => Object.fromEntries(Object.entries(stats).filter(([id]) => keep(publicIds.has(id))));
fs.writeFileSync(out, JSON.stringify(pick((pub) => pub), null, 1));
fs.writeFileSync(outLocal, JSON.stringify(pick((pub) => !pub), null, 1));
console.log('\nok', Object.keys(stats).length);
