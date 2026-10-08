import { analyzeAvatar, validateImageData } from './avatar.js';

export const DEFAULT_ALLOWED_ORIGINS = ['https://toooonyliu.github.io', 'http://localhost:4173', 'http://127.0.0.1:4173'];
export const MAX_BODY_BYTES = 2_800_000;
const fail = (message, status) => Object.assign(new Error(message), { status });

export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function allowedOrigins(value) {
  const list = Array.isArray(value) ? value : String(value).split(',');
  return new Set(list.map(item => item.trim()).filter(item => {
    try { const url = new URL(item); return ['http:', 'https:'].includes(url.protocol) && url.origin === item; } catch { return false; }
  }));
}

function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); return Promise.reject(fail('Image is too large. Compress it and try again.', 413)); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onError = () => { cleanup(); reject(fail('Could not read the request. Try again.', 400)); };
    const onAborted = () => { cleanup(); reject(fail('Upload canceled.', 400)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); req.resume(); reject(fail('Image is too large. Compress it and try again.', 413)); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

// CORS controls browser origins, not authentication. Only request timestamps are retained.
export function createAvatarRoute(options = {}) {
  const origins = allowedOrigins(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS);
  const perMinute = Math.max(1, Number(options.perMinute ?? process.env.AI_PER_MINUTE) || 5);
  const maxCalls = Math.max(1, Number(options.maxCalls ?? process.env.AI_MAX_CALLS) || 50);
  const maxConcurrent = Math.max(1, Math.min(8, Math.floor(Number(options.maxConcurrent ?? process.env.AI_MAX_CONCURRENT) || 2)));
  const requireOrigin = [true, 'true', '1'].includes(options.requireOrigin ?? process.env.AI_REQUIRE_ORIGIN);
  const limits = new Map();
  let calls = 0;
  let inFlight = 0;
  const analyzer = options.analyze || analyzeAvatar;
  return async (req, res, url) => {
    const serviceInfo = url.pathname === '/' && options.serviceInfoRoot === true;
    if (!['/api/analyze-avatar', '/health'].includes(url.pathname) && !serviceInfo) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    const sameOrigin = options.allowSameOrigin && origin === `http://${req.headers.host}`;
    if (origin && !origins.has(origin) && !sameOrigin) { sendJson(res, 403, { error: 'This website origin is not allowed.' }); return true; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (url.pathname === '/health' || serviceInfo) {
      if (!['GET', 'HEAD'].includes(req.method)) sendJson(res, 405, { error: 'Use GET.' });
      else {
        const readiness = { status: 'ok', avatarAnalysisConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) };
        sendJson(res, 200, url.pathname === '/health' ? readiness : {
          service: 'One Cut Atlas avatar API', ...readiness,
          routes: { health: '/health', analyze: '/api/analyze-avatar' }
        });
      }
      return true;
    }
    // Requiring Origin reduces accidental access; it is not authentication.
    if (requireOrigin && !origin) { sendJson(res, 403, { error: 'Use AI Colors from the game website.' }); return true; }
    if (req.method === 'OPTIONS') {
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'POST' || requestedHeaders.some(header => header !== 'content-type')) sendJson(res, 403, { error: 'Unsupported preflight request.' });
      else { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); }
      return true;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); sendJson(res, 405, { error: 'Use POST.' }); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']))) { sendJson(res, 415, { error: 'Send image data as JSON.' }); return true; }
    try {
      const busy = () => Object.assign(fail('AI is busy. Try again shortly or keep your local preview.', 429), { retryAfter: 5 });
      if (inFlight >= maxConcurrent) throw busy();
      let data;
      try { data = JSON.parse(await readBody(req)); } catch (error) { if (error.status) throw error; throw fail('Request body is not valid JSON.', 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'image')) throw fail('Send only the image field.', 400);
      validateImageData(data.image);
      const now = Date.now();
      // Prune stale timestamps and cap bookkeeping without retaining request bodies.
      for (const [address, timestamps] of limits) {
        const active = timestamps.filter(time => now - time < 60_000);
        if (active.length) limits.set(address, active); else limits.delete(address);
      }
      const ip = req.socket.remoteAddress || 'unknown';
      const recent = limits.get(ip) || [];
      // No await between the final checks and reservations: concurrent uploads
      // cannot spend the same remaining request or analysis slot.
      if (inFlight >= maxConcurrent) throw busy();
      if (recent.length >= perMinute || calls >= maxCalls || (limits.size >= 10_000 && !limits.has(ip))) throw fail('Analysis limit reached. Try later or keep your local preview.', 429);
      recent.push(now); limits.set(ip, recent); calls++; inFlight++;
      try { sendJson(res, 200, { avatar: await analyzer(data, options.provider), source: 'ai' }); }
      finally { inFlight--; }
    } catch (error) {
      if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter || 60));
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Analysis is unavailable. Your local preview is unchanged.' });
    }
    return true;
  };
}
