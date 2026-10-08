import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAvatar, validateModelAvatar, validateImageData } from '../server/avatar.js';
import { createBackendServer } from '../server.mjs';

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
  assert.match(request.body.instructions, /Do not identify the person/);
});

test('provider refusal, unavailable service and malformed output leave actionable fallback', async () => {
  const options = { apiKey: 'dummy-test-key', model: 'test-model' };
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: false, status: 429 }) }), { status: 429 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }) }) }), { status: 422 });
  await assert.rejects(analyzeAvatar({ image: png }, { ...options, fetch: async () => ({ ok: true, json: async () => output({ ...avatar(), style: 'invented' }) }) }), { status: 502 });
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
