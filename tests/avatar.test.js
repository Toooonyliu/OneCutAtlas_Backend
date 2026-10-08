import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { analyzeAvatar, validateModelAvatar, validateImageData } from '../server/avatar.js';
import { createBackendServer } from '../server.mjs';
import { createAvatarRoute } from '../server/http.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const avatar = () => ({ palette: { hair: '#24212B', skin: '#d5a380', outfit: '#596c76', accent: '#c89d54' }, style: 'traveler', hairStyle: 'short', summary: 'A dark jacket and warm accessories.' });
const output = value => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('strict avatar boundary rejects invented fields, styles and colors', () => {
  assert.equal(validateModelAvatar(avatar()).palette.hair, '#24212b');
  assert.throws(() => validateModelAvatar({ ...avatar(), identity: 'invented name' }), { status: 502 });
  assert.throws(() => validateModelAvatar({ ...avatar(), style: 'ninja' }), { status: 502 });
  assert.throws(() => validateModelAvatar({ ...avatar(), hairStyle: 'bald' }), { status: 502 });
  assert.throws(() => validateModelAvatar({ ...avatar(), palette: { ...avatar().palette, skin: 'red' } }), { status: 502 });
  assert.throws(() => validateModelAvatar({ ...avatar(), summary: 'x'.repeat(241) }), { status: 502 });
});

test('image boundary rejects URLs, spoofed MIME and pixel bombs', () => {
  assert.equal(validateImageData(png), png);
  assert.throws(() => validateImageData('https://example.com/photo.png'), { status: 400 });
  assert.throws(() => validateImageData(png.replace('image/png', 'image/jpeg')), { status: 400 });
  const bomb = Buffer.from(png.split(',')[1], 'base64');
  bomb.writeUInt32BE(50_000_000, 16);
  assert.throws(() => validateImageData(`data:image/png;base64,${bomb.toString('base64')}`), { status: 400 });
});

test('unconfigured AI fails before any provider call, preserving local mode', async () => {
  let calls = 0;
  const options = { apiKey: '', model: '', fetch: () => { calls++; } };
  await assert.rejects(analyzeAvatar({ image: png }, options), { status: 503 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, apiKey: 'dummy-test-key' }), { status: 503 });
  assert.equal(calls, 0);
});

test('provider request uses bounded image and strict JSON schema without response storage', async () => {
  let request;
  const result = await analyzeAvatar({ image: png }, {
    apiKey: 'dummy-test-key', model: 'test-model', fetch: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return { ok: true, json: async () => output(avatar()) };
    }
  });
  assert.equal(result.style, 'traveler');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.model, 'test-model');
  assert.equal(request.body.input[0].content[1].image_url, png);
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.equal(Object.hasOwn(request.body, 'reasoning'), false);
  assert.match(request.body.instructions, /Do not identify the person/);
});

test('GPT-6 Luna and snapshots use no reasoning without modifying other model requests', async () => {
  for (const model of ['gpt-6-luna', 'gpt-6-luna-2026-10-01', 'test-model']) {
    let body;
    await analyzeAvatar({ image: png }, {
      apiKey: 'dummy-test-key', model, fetch: async (url, options) => {
        body = JSON.parse(options.body);
        return { ok: true, json: async () => output(avatar()) };
      }
    });
    assert.equal(body.max_output_tokens, 1000);
    assert.deepEqual(body.reasoning, model.startsWith('gpt-6-luna') ? { effort: 'none' } : undefined);
  }
});

test('provider refusal, unavailable service and malformed output leave actionable fallback', async () => {
  const options = { apiKey: 'dummy-test-key', model: 'test-model' };
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: false, status: 429 }) }), { status: 429 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }) }) }), { status: 422 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => output({ ...avatar(), style: 'invented' }) }) }), { status: 502 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => ({ status: 'incomplete', output: [] }) }) }), { status: 502 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] }) }) }), { status: 502 });
});

test('provider timeout aborts and reports local fallback', async () => {
  await assert.rejects(analyzeAvatar({ image: png }, {
    apiKey: 'dummy-test-key', model: 'test-model', timeoutMs: 5,
    fetch: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  }), { status: 504 });
});

async function withServer(options, work) {
  const server = createBackendServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

// Controlled uploads expose the race that occurs when every request is checked
// before any of its bodies have finished. No provider or network is involved.
function beginUpload(route, body = { image: png }) {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' }, resume() {}
  });
  const response = { headers: {} };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) { response.status = status; Object.assign(response.headers, headers); },
    end(value) { response.body = JSON.parse(value); }
  };
  const result = route(req, res, new URL('http://localhost/api/analyze-avatar')).then(() => response);
  return { req, result, upload() { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); } };
}

test('completed concurrent bodies cannot race past total-call or per-minute limits', async () => {
  for (const options of [{ maxCalls: 1, perMinute: 20 }, { maxCalls: 20, perMinute: 1 }]) {
    let calls = 0;
    const route = createAvatarRoute({ ...options, maxConcurrent: 8, analyze: async () => { calls++; return avatar(); } });
    const uploads = Array.from({ length: 4 }, () => beginUpload(route));
    uploads.forEach(upload => upload.upload());
    const responses = await Promise.all(uploads.map(upload => upload.result));
    assert.equal(calls, 1);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 429, 429, 429]);
  }
});

test('analysis concurrency stays bounded and slots recover after success and failure', async () => {
  const releases = [];
  let calls = 0;
  const route = createAvatarRoute({ maxConcurrent: 1, perMinute: 20, analyze: () => {
    calls++;
    return new Promise((resolve, reject) => releases.push({ resolve, reject }));
  } });
  const first = beginUpload(route), second = beginUpload(route);
  first.upload(); second.upload();
  const denied = await second.result;
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['retry-after'], '5');
  assert.equal(calls, 1);
  releases.shift().resolve(avatar());
  assert.equal((await first.result).status, 200);

  const failed = beginUpload(route);
  failed.upload();
  await Promise.resolve();
  releases.shift().reject(Object.assign(new Error('Mock provider unavailable.'), { status: 502 }));
  assert.equal((await failed.result).status, 502);
  const recovered = beginUpload(route);
  recovered.upload();
  await Promise.resolve();
  releases.shift().resolve(avatar());
  assert.equal((await recovered.result).status, 200);
  assert.equal(calls, 3);
});

test('invalid images and canceled uploads never reserve provider call slots', async () => {
  let calls = 0;
  const route = createAvatarRoute({ maxCalls: 1, analyze: async () => { calls++; return avatar(); } });
  const invalid = beginUpload(route, { image: 'not-image-data' });
  invalid.upload();
  assert.equal((await invalid.result).status, 400);
  const canceled = beginUpload(route);
  canceled.req.emit('aborted');
  assert.equal((await canceled.result).status, 400);
  const valid = beginUpload(route);
  valid.upload();
  assert.equal((await valid.result).status, 200);
  assert.equal(calls, 1);
});

test('production origin requirement rejects bare analysis while health and root remain public', async () => {
  let calls = 0;
  await withServer({ requireOrigin: true, serviceInfoRoot: true, analyze: async () => { calls++; return avatar(); } }, async base => {
    const denied = await fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const root = await fetch(base);
    assert.equal(root.status, 200);
    assert.equal((await root.json()).service, 'One Cut Atlas avatar API');
    const accepted = await fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { Origin: 'https://toooonyliu.github.io', 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) });
    assert.equal(accepted.status, 200);
    assert.equal(calls, 1);
  });
});

test('HTTP route allows portfolio preflight and rejects other origins before analysis', async () => {
  let calls = 0;
  await withServer({ analyze: async () => { calls++; return validateModelAvatar(avatar()); } }, async base => {
    const preflight = await fetch(`${base}/api/analyze-avatar`, { method: 'OPTIONS', headers: { Origin: 'https://toooonyliu.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://toooonyliu.github.io');
    const denied = await fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);
    const accepted = await fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { Origin: 'https://toooonyliu.github.io', 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).avatar.palette.hair, '#24212b');
    assert.equal(calls, 1);
  });
});

test('HTTP route bounds bodies and rate limits without receiving a provider response', async () => {
  await withServer({ perMinute: 1, analyze: async () => validateModelAvatar(avatar()) }, async base => {
    const send = body => fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const large = await send(JSON.stringify({ image: 'x'.repeat(2_800_001) }));
    assert.equal(large.status, 413);
    const first = await send(JSON.stringify({ image: png }));
    assert.equal(first.status, 200);
    const second = await send(JSON.stringify({ image: png }));
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '60');
  });
});

test('HTTP unavailable mode returns no image, private key or configuration value', async () => {
  await withServer({ provider: { apiKey: '', model: '' } }, async base => {
    const response = await fetch(`${base}/api/analyze-avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: png }) });
    assert.equal(response.status, 503);
    const body = await response.text();
  assert.match(body, /local/i);
    assert.equal(body.includes(png), false);
    assert.deepEqual(Object.keys(JSON.parse(body)), ['error']);
  });
});
