import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createSyntheticPng, runOpusSmoke } from '../scripts/opus_smoke.mjs';

test('synthetic PNG contains the expected white canvas and red rectangle', () => {
  const png = createSyntheticPng();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 240);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), 'IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  const pixel = (x, y) => [...pixels.subarray(y * 961 + 1 + x * 3, y * 961 + 4 + x * 3)];
  assert.deepEqual(pixel(0, 0), [255, 255, 255]);
  assert.deepEqual(pixel(140, 110), [255, 0, 0]);
  assert.deepEqual(pixel(80, 60), [255, 0, 0]);
  assert.deepEqual(pixel(200, 160), [255, 0, 0]);
  assert.deepEqual(pixel(201, 160), [255, 255, 255]);
});

test('smoke sends exactly one synthetic request and checks model, shape and coordinates', async () => {
  let requests = 0;
  const report = await runOpusSmoke({
    config: { baseUrl: 'https://example.invalid/', authToken: 'offline-test-token' },
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, 'https://example.invalid/v1/messages');
      assert.equal(options.headers.Authorization, 'Bearer offline-test-token');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'claude-opus-5');
      assert.equal(payload.max_tokens, 256);
      assert.equal(payload.messages[0].content[0].source.data, createSyntheticPng().toString('base64'));
      assert.equal(payload.messages[0].content[1].text.includes('140'), false);
      return { ok: true, status: 200, json: async () => ({ model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 198, output_tokens: 118 }, content: [{ type: 'text', text: '{"shape":"rectangle","color":"red","center":{"x":141,"y":109}}' }] }) };
    }
  });
  assert.equal(requests, 1);
  assert.equal(report.passed, true);
  assert.equal(report.centerErrorPx, 1.414);
  assert.equal(JSON.stringify(report).includes('offline-test-token'), false);
});

test('HTTP failure, a different model or wrong center cannot pass the smoke', async () => {
  const config = { baseUrl: 'https://example.invalid', apiKey: 'offline-key' };
  await assert.rejects(runOpusSmoke({ config, fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
  for (const [model, center] of [['different-model', { x: 140, y: 110 }], ['claude-opus-5', { x: 20, y: 20 }]]) {
    const report = await runOpusSmoke({ config, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ shape: 'rectangle', color: 'red', center }) }] }) }) });
    assert.equal(report.passed, false);
  }
});
