import { analyzeAvatar } from './avatar.js';

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
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); return Promise.reject(fail('图片太大，请压缩后重试。', 413)); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onError = () => { cleanup(); reject(fail('无法读取请求，请重试。', 400)); };
    const onAborted = () => { cleanup(); reject(fail('上传已取消。', 400)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); req.resume(); reject(fail('图片太大，请压缩后重试。', 413)); }
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
  const limits = new Map();
  let calls = 0;
  const analyzer = options.analyze || analyzeAvatar;
  return async (req, res, url) => {
    if (!['/api/analyze-avatar', '/health'].includes(url.pathname)) return false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    const sameOrigin = options.allowSameOrigin && origin === `http://${req.headers.host}`;
    if (origin && !origins.has(origin) && !sameOrigin) { sendJson(res, 403, { error: '这个网页来源未获允许。' }); return true; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (url.pathname === '/health') {
      if (!['GET', 'HEAD'].includes(req.method)) sendJson(res, 405, { error: 'Use GET.' });
      else sendJson(res, 200, { status: 'ok', avatarAnalysisConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) });
      return true;
    }
    if (req.method === 'OPTIONS') {
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'POST' || requestedHeaders.some(header => header !== 'content-type')) sendJson(res, 403, { error: 'Unsupported preflight request.' });
      else { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); }
      return true;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); sendJson(res, 405, { error: '请使用 POST 请求。' }); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']))) { sendJson(res, 415, { error: '请发送 JSON 图片数据。' }); return true; }
    try {
      const now = Date.now();
      // Prune stale timestamps and cap bookkeeping without retaining request bodies.
      for (const [address, timestamps] of limits) {
        const active = timestamps.filter(time => now - time < 60_000);
        if (active.length) limits.set(address, active); else limits.delete(address);
      }
      const ip = req.socket.remoteAddress || 'unknown';
      const recent = limits.get(ip) || [];
      if (recent.length >= perMinute || calls >= maxCalls || (limits.size >= 10_000 && !limits.has(ip))) throw fail('分析次数已达限制，请稍后再试或使用本地预览。', 429);
      let data;
      try { data = JSON.parse(await readBody(req)); } catch (error) { if (error.status) throw error; throw fail('请求内容不是有效 JSON。', 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'image')) throw fail('请仅发送 image 照片字段。', 400);
      recent.push(now); limits.set(ip, recent); calls++;
      sendJson(res, 200, { avatar: await analyzer(data, options.provider), source: 'ai' });
    } catch (error) {
      if (error.status === 429) res.setHeader('Retry-After', '60');
      sendJson(res, error.status || 500, { error: error.status ? error.message : '暂时无法分析，请保留本地预览。' });
    }
    return true;
  };
}
