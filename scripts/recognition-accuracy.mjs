// Compares place-recognition settings on a folder of authorized photos. Billable (one vision call per photo per setting).
//   node --env-file=/path/.env scripts/recognition-accuracy.mjs --photos a.jpg b.jpg --out results.json
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recognizePlace } from '../server/scene.js';
const args = process.argv.slice(2);
const list = name => { const i = args.indexOf(`--${name}`); if (i < 0) return []; const v = []; for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) v.push(args[k]); return v; };
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const photos = list('photos'), out = option('out', 'recognition-results.json');
const SETTINGS = { 'low-none': { detail: 'low', reasoning: 'none' }, 'high-none': { detail: 'high', reasoning: 'none' }, 'high-low': { detail: 'high', reasoning: 'low' } };
const chosen = (option('settings', Object.keys(SETTINGS).join(',')) || '').split(',').filter(Boolean);
if (!photos.length || !process.env.OPENAI_API_KEY) { console.error('Need --photos and OPENAI_API_KEY'); process.exit(1); }
const rows = [];
for (const file of photos) {
  const label = path.basename(file, path.extname(file));
  const image = `data:image/jpeg;base64,${(await readFile(file)).toString('base64')}`;
  for (const name of chosen) {
    const started = Date.now();
    try {
      const { place, usage } = await recognizePlace({ image }, SETTINGS[name]);
      rows.push({ photo: label, setting: name, seconds: (Date.now() - started) / 1000, name: place.name, city: place.city, country: place.country, zone: place.zone, confidence: place.confidence, summary: place.summary, evidence: place.evidence, tokens: usage?.total_tokens ?? null, input: usage?.input_tokens ?? null, output: usage?.output_tokens ?? null });
      console.log(`${label.padEnd(18)} ${name.padEnd(10)} ${String(place.confidence).padEnd(5)} ${(place.name || '-').padEnd(34)} ${(place.city || '-').padEnd(14)} ${(place.country || '-').padEnd(14)} ${place.zone.padEnd(16)} ${usage?.total_tokens ?? '?'}tok ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      rows.push({ photo: label, setting: name, error: error.message, status: error.status });
      console.log(`${label.padEnd(18)} ${name.padEnd(10)} FAILED ${error.status || ''} ${error.message}`);
    }
  }
}
await writeFile(out, JSON.stringify(rows, null, 2));
console.log(`saved ${out}`);
