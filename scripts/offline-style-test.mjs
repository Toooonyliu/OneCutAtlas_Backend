// Offline style test: recognize a few authorized photos, then paint backdrops
// in several variants so quality and reference settings can be compared by eye.
// Billable. Run deliberately, e.g.
//   node --env-file=/path/to/.env scripts/offline-style-test.mjs --out ./out --photos a.jpg b.jpg --variants low-ref,medium-ref
// The key is read by Node from the env file; this script never prints it.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { recognizePlace, paintBackdrop, buildBackdropPrompt, loadStyleReferences } from '../server/scene.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const list = name => { const index = args.indexOf(`--${name}`); if (index < 0) return []; const values = []; for (let i = index + 1; i < args.length && !args[i].startsWith('--'); i++) values.push(args[i]); return values; };
const out = option('out', './offline-style-out');
const photos = list('photos');
const variants = (option('variants', 'low-ref') || '').split(',').filter(Boolean);
const recognizeOnly = args.includes('--recognize-only');
if (!photos.length) { console.error('Pass --photos <files...>'); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set (use --env-file).'); process.exit(1); }
await mkdir(out, { recursive: true });

// Published token rates (USD per million), October 2026 pricing page.
const RATES = { 'gpt-image-2': { imageIn: 8, textIn: 5, imageOut: 30 }, 'gpt-image-1.5': { imageIn: 8, textIn: 5, imageOut: 32 }, 'gpt-image-1-mini': { imageIn: 2.5, textIn: 2, imageOut: 8 } };
function estimate(model, usage) {
  const rate = RATES[model]; if (!rate || !usage) return null;
  const inImg = usage.input_tokens_details?.image_tokens ?? 0, inText = usage.input_tokens_details?.text_tokens ?? (usage.input_tokens ?? 0) - inImg;
  return ((inImg * rate.imageIn + inText * rate.textIn + (usage.output_tokens ?? 0) * rate.imageOut) / 1e6);
}
const mimeOf = file => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file).toLowerCase()];
const log = [];
let total = 0;
for (const file of photos) {
  const label = path.basename(file, path.extname(file));
  const bytes = await readFile(file);
  const image = `data:${mimeOf(file)};base64,${bytes.toString('base64')}`;
  console.log(`\n== ${label} (${(bytes.length / 1024).toFixed(0)} KB)`);
  const started = Date.now();
  const { place, usage } = await recognizePlace({ image });
  console.log(`recognized in ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(place, null, 1));
  console.log('recognition usage:', JSON.stringify(usage));
  log.push({ photo: label, place, recognitionUsage: usage });
  await writeFile(path.join(out, `${label}-place.json`), JSON.stringify(place, null, 2));
  if (recognizeOnly) continue;
  for (const variant of variants) {
    const [quality, refs] = variant.split('-');
    const references = refs === 'ref' ? await loadStyleReferences() : [];
    const prompt = buildBackdropPrompt({ scenePrompt: place.scenePrompt, setting: place.setting, lighting: place.lighting, references: references.length > 0 });
    await writeFile(path.join(out, `${label}-${variant}-prompt.txt`), prompt);
    const begin = Date.now();
    try {
      const result = await paintBackdrop({ prompt }, { quality, references });
      const seconds = ((Date.now() - begin) / 1000).toFixed(1);
      const cost = estimate(result.model, result.usage);
      total += cost || 0;
      const target = path.join(out, `${label}-${variant}.${result.mime.split('/')[1]}`);
      await writeFile(target, Buffer.from(result.backdrop.split(',')[1], 'base64'));
      console.log(`${variant}: ${seconds}s, ${(result.bytes / 1024).toFixed(0)} KB ${result.mime}, usage ${JSON.stringify(result.usage)}, est $${cost?.toFixed(4) ?? '?'} → ${target}`);
      log.push({ photo: label, variant, seconds: Number(seconds), usage: result.usage, estimatedUsd: cost, file: target, model: result.model, size: result.size, references: result.references });
    } catch (error) {
      console.log(`${variant}: FAILED ${error.status || ''} ${error.message}${error.detail ? ` | provider: ${error.detail}` : ''}`);
      log.push({ photo: label, variant, failed: true, status: error.status, message: error.message, detail: error.detail });
      if (error.status === 503 || error.providerStatus === 400) { console.log('Stopping: fix configuration or parameters before spending more.'); break; }
    }
  }
}
await writeFile(path.join(out, 'log.json'), JSON.stringify(log, null, 2));
console.log(`\nEstimated image spend this run: $${total.toFixed(4)} (recognition not included). Log: ${path.join(out, 'log.json')}`);
