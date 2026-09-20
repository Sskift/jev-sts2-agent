import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Offline reference data only. Gameplay never depends on a live Wiki request.
const base = 'https://spire-codex.com';
const expectedVersion = process.argv[2] || 'v0.111.0';
if (!/^v\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error('Expected a game version such as v0.111.0');
const categories = ['cards', 'relics', 'potions', 'powers', 'events', 'monsters', 'encounters', 'characters', 'keywords', 'enchantments', 'afflictions', 'intents', 'orbs', 'modifiers'];
async function get(route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}; no snapshot written`);
  return response.json();
}
const before = await get('/api/beta/version');
if (before.beta_version !== expectedVersion) throw new Error(`Beta is ${before.beta_version}, not ${expectedVersion}; existing data retained`);
const records = {};
for (let offset = 0; offset < categories.length; offset += 4) {
  const batch = categories.slice(offset, offset + 4);
  const results = await Promise.allSettled(batch.map(category => get(`/api/${category}?lang=eng&channel=beta`)));
  for (const [index, result] of results.entries()) {
    if (result.status !== 'fulfilled') throw result.reason;
    const category = batch[index], rows = result.value;
    if (!Array.isArray(rows) || !rows.length || rows.some(row => typeof row.id !== 'string')) throw new Error(`Invalid ${category} export`);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`Duplicate ${category} IDs`);
    records[category] = rows;
  }
}
if ((await get('/api/beta/version')).beta_version !== expectedVersion) throw new Error('Data version changed during download; no snapshot written');
const directory = new URL(`../data/spire-codex/${expectedVersion}/`, import.meta.url);
fs.mkdirSync(directory, { recursive: true });
const files = {};
for (const [category, rows] of Object.entries(records)) {
  const body = JSON.stringify(rows) + '\n';
  fs.writeFileSync(new URL(category + '.json', directory), body);
  files[category] = { count: rows.length, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), url: `${base}/api/${category}?lang=eng&channel=beta` };
}
const manifest = { source: 'Spire Codex', source_url: base + '/developers', game_version: expectedVersion, channel: 'beta', language: 'eng', fetched_at: new Date().toISOString(), terms_url: 'https://github.com/ptrlrd/spire-codex/blob/main/API_TERMS.md', files };
fs.writeFileSync(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory: fileURLToPath(directory), version: expectedVersion, counts: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.count])) }));
