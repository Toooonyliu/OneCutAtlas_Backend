// Photo arena routes: recognize a place, then paint a backdrop as a polled job.
// Caps are demo guards in memory; the prepaid provider balance is the hard limit.
import { createHash } from 'node:crypto';
import { recognizePlace, paintArena, buildBackdropPrompt, ZONES, SETTINGS, LIGHTINGS, SCENE_PROMPT_PATTERN, PLACE_NAME_PATTERN } from './scene.js';
import { validateImageData } from './image.js';
import { allowedOrigins, readBody, sendJson, DEFAULT_ALLOWED_ORIGINS } from './http.js';
import { createJobStore } from './jobs.js';

const fail = (message, status, retryAfter) => Object.assign(new Error(message), { status, ...(retryAfter ? { retryAfter } : {}) });
const count = (value, fallback, low = 1, high = 100_000) => Math.max(low, Math.min(high, Math.floor(Number(value)) || fallback));
const flag = (value, fallback) => value === undefined || value === null || value === '' ? fallback : [true, 'true', '1'].includes(value);
export const JOB_ID = /^\/api\/scenes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function createSceneRoutes(options = {}) {
  const origins = allowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS);
  const requireOrigin = flag(options.requireOrigin ?? process.env.AI_REQUIRE_ORIGIN, false);
  const enabled = flag(options.enabled ?? process.env.SCENE_ENABLED, true);
  const recognizePerMinute = count(options.recognizePerMinute ?? process.env.RECOGNIZE_PER_MINUTE, 5);
  const scenesPerHour = count(options.scenesPerHour ?? process.env.SCENE_PER_HOUR, 3);
  const scenesPerDay = count(options.scenesPerDay ?? process.env.SCENE_MAX_PER_DAY, 40);
  const maxConcurrent = count(options.maxConcurrent ?? process.env.SCENE_MAX_CONCURRENT, 2, 1, 4);
  const cacheTtlMs = options.cacheTtlMs ?? 600_000;
  const now = options.now || Date.now;
  const jobs = createJobStore({ maxJobs: options.maxJobs ?? 20, ttlMs: options.jobTtlMs ?? 600_000, now });
  const recognizer = options.recognize || recognizePlace;
  const painter = options.paint || paintArena;
  const recognizeHits = new Map(), sceneHits = new Map(), cache = new Map();
  let dayHits = [], inFlight = 0;
  const recent = (map, ip, windowMs) => {
    const time = now();
    for (const [address, times] of map) { const live = times.filter(value => time - value < windowMs); if (live.length) map.set(address, live); else map.delete(address); }
    return map.get(ip) || [];
  };
  const reserve = (map, ip, list) => { list.push(now()); map.set(ip, list); };
  return async (req, res, url) => {
    const jobId = JOB_ID.exec(url.pathname)?.[1];
    if (!['/api/recognize-place', '/api/scenes'].includes(url.pathname) && !jobId) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    const sameOrigin = options.allowSameOrigin && origin === `http://${req.headers.host}`;
    if (origin && !origins.has(origin) && !sameOrigin) { sendJson(res, 403, { error: 'This website origin is not allowed.' }); return true; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (requireOrigin && !origin) { sendJson(res, 403, { error: 'Use photo arenas from the game website.' }); return true; }
    if (req.method === 'OPTIONS') {
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      const method = req.headers['access-control-request-method'];
      if (!(jobId ? method === 'GET' : method === 'POST') || requestedHeaders.some(header => header !== 'content-type')) sendJson(res, 403, { error: 'Unsupported preflight request.' });
      else { res.writeHead(204, { 'Access-Control-Allow-Methods': jobId ? 'GET' : 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); }
      return true;
    }
    if (jobId) {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); sendJson(res, 405, { error: 'Use GET.' }); return true; }
      const job = jobs.get(jobId);
      if (!job) { sendJson(res, 404, { error: 'This arena request expired or the service restarted. Paint it again.' }); return true; }
      if (job.status === 'done') sendJson(res, 200, { status: 'done', backdrop: job.result.backdrop, cached: job.result.cached === true });
      else if (job.status === 'failed') sendJson(res, 200, { status: 'failed', error: job.error.message });
      else sendJson(res, 200, { status: job.status });
      return true;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); sendJson(res, 405, { error: 'Use POST.' }); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']))) { sendJson(res, 415, { error: 'Send photo data as JSON.' }); return true; }
    const ip = req.socket.remoteAddress || 'unknown';
    try {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch (error) { if (error.status) throw error; throw fail('Request body is not valid JSON.', 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Send a JSON object.', 400);
      if (url.pathname === '/api/recognize-place') {
        const keys = Object.keys(data);
        if (!keys.includes('image') || keys.some(key => !['image', 'zone', 'gps', 'exclude'].includes(key))) throw fail('Send image with optional zone, gps and exclude.', 400);
        validateImageData(data.image);
        if (data.zone !== undefined && !ZONES.includes(data.zone)) throw fail('Choose a valid travel zone.', 400);
        if (data.gps !== undefined && data.gps !== null && !(data.gps && typeof data.gps === 'object' && !Array.isArray(data.gps) && Object.keys(data.gps).length === 2 && Number.isFinite(data.gps.lat) && Number.isFinite(data.gps.lon) && Math.abs(data.gps.lat) <= 90 && Math.abs(data.gps.lon) <= 180)) throw fail('Photo coordinates are invalid.', 400);
        if (data.exclude !== undefined && data.exclude !== null && (!Array.isArray(data.exclude) || data.exclude.length > 3 || data.exclude.some(item => typeof item !== 'string' || !PLACE_NAME_PATTERN.test(item.trim())))) throw fail('Excluded places must be up to three plain names.', 400);
        const hits = recent(recognizeHits, ip, 60_000);
        if (hits.length >= recognizePerMinute || (recognizeHits.size >= 10_000 && !recognizeHits.has(ip))) throw fail('Recognition limit reached. Try later or choose the zone yourself.', 429, 60);
        reserve(recognizeHits, ip, hits);
        const { place } = await recognizer({ image: data.image, zone: data.zone, gps: data.gps ?? undefined, exclude: data.exclude ?? undefined }, options.provider);
        sendJson(res, 200, { place, source: 'ai' });
        return true;
      }
      if (!enabled) throw fail('Arena painting is turned off. Preset arenas still work.', 503);
      const fields = ['image', 'zone', 'scenePrompt', 'setting', 'lighting'];
      if (fields.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !fields.includes(key) && key !== 'placeName')) throw fail('Send image, zone, scenePrompt, setting, lighting and an optional placeName.', 400);
      if (data.placeName !== undefined && data.placeName !== null && (typeof data.placeName !== 'string' || !PLACE_NAME_PATTERN.test(data.placeName.trim()))) throw fail('Place name must be 2 to 80 plain characters.', 400);
      validateImageData(data.image);
      if (!ZONES.includes(data.zone) || !SETTINGS.includes(data.setting) || !LIGHTINGS.includes(data.lighting)) throw fail('Choose a valid zone, setting and lighting.', 400);
      if (typeof data.scenePrompt !== 'string' || !SCENE_PROMPT_PATTERN.test(data.scenePrompt.trim())) throw fail('Scene description must be 20 to 300 plain characters.', 400);
      const prompt = buildBackdropPrompt({ scenePrompt: data.scenePrompt, setting: data.setting, lighting: data.lighting, zone: data.zone, placeName: data.placeName ?? null });
      const key = createHash('sha256').update(data.image).update('\n').update(prompt).digest('hex');
      for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(cacheKey);
      const hit = cache.get(key);
      if (hit) { const job = jobs.create(async () => ({ backdrop: hit.backdrop, cached: true })); sendJson(res, 202, { jobId: job.id, estimatedSeconds: 1 }); return true; }
      if (jobs.size >= (options.maxJobs ?? 20)) throw fail('Too many arenas are being painted right now. Try again in a few minutes.', 429, 60);
      if (inFlight >= maxConcurrent) throw fail('Arena painting is busy. Try again shortly or keep the preset arena.', 429, 10);
      const hourly = recent(sceneHits, ip, 3_600_000);
      dayHits = dayHits.filter(value => now() - value < 86_400_000);
      if (hourly.length >= scenesPerHour || (sceneHits.size >= 10_000 && !sceneHits.has(ip))) throw fail('You have painted enough arenas for this hour. Preset arenas still work.', 429, 600);
      if (dayHits.length >= scenesPerDay) throw fail('Today\'s arena painting budget is used up. Preset arenas still work.', 429, 3600);
      // Reservations happen before any await so concurrent uploads cannot share a slot.
      reserve(sceneHits, ip, hourly); dayHits.push(now()); inFlight++;
      let job;
      try {
        job = jobs.create(async () => {
          try {
            const result = await painter({ prompt }, options.provider);
            if (cache.size >= 20) cache.delete(cache.keys().next().value);
            cache.set(key, { backdrop: result.backdrop, expiresAt: now() + cacheTtlMs });
            return { backdrop: result.backdrop };
          } finally { inFlight--; }
        });
      } catch (error) { inFlight--; throw error; }
      sendJson(res, 202, { jobId: job.id, estimatedSeconds: 40 });
    } catch (error) {
      if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter || 60));
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Photo arenas are unavailable. Preset arenas still work.' });
    }
    return true;
  };
}
