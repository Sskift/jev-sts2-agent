import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { getClaudeConfig, VISION_MODEL } from '../src/vision_opus.mjs';

export const SYNTHETIC_SCENE = Object.freeze({ width: 320, height: 240, center: { x: 140, y: 110 }, tolerancePx: 8 });

class SmokeTestError extends Error {}

function pngChunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

/** Generated RGB pixels only. No desktop access, Python or external assets. */
export function createSyntheticPng() {
  const { width, height } = SYNTHETIC_SCENE;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * stride] = 0;
    for (let x = 80; y >= 60 && y <= 160 && x <= 200; x++) {
      pixels[y * stride + 1 + x * 3 + 1] = 0;
      pixels[y * stride + 1 + x * 3 + 2] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** One real vision request by default; fetch injection is for offline tests. */
export async function runOpusSmoke({ config = getClaudeConfig(), fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new SmokeTestError('TLS verification is disabled; remove NODE_TLS_REJECT_UNAUTHORIZED=0');
  if (!config.authToken && !config.apiKey) throw new SmokeTestError('Claude credentials are not configured');
  const started = Date.now();
  const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : { 'x-api-key': config.apiKey }),
      'anthropic-version': '2023-06-01', 'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: VISION_MODEL, max_tokens: 256,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: createSyntheticPng().toString('base64') } },
        { type: 'text', text: 'Identify the single colored geometric shape against the white background. Return only JSON {"shape":string,"color":string,"center":{"x":number,"y":number}}. Use lowercase English shape and color names, and pixel coordinates for the center in the supplied image.' }
      ] }]
    })
  });
  if (!response.ok) throw new SmokeTestError(`Claude API error ${response.status}`);
  const data = await response.json();
  if (data.stop_reason !== 'end_turn') throw new SmokeTestError('Claude returned an incomplete response');
  const rawText = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  let observed;
  try { observed = JSON.parse(rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new SmokeTestError('Claude did not return a JSON object'); }
  if (!observed || typeof observed.shape !== 'string' || typeof observed.color !== 'string' || !Number.isFinite(observed.center?.x) || !Number.isFinite(observed.center?.y)) {
    throw new SmokeTestError('Claude returned an invalid shape observation');
  }
  const distance = Math.hypot(observed.center.x - SYNTHETIC_SCENE.center.x, observed.center.y - SYNTHETIC_SCENE.center.y);
  return {
    testedAt: new Date(started).toISOString(),
    passed: data.model === VISION_MODEL && observed.shape.toLowerCase() === 'rectangle' && observed.color.toLowerCase() === 'red' && distance <= SYNTHETIC_SCENE.tolerancePx,
    requestedModel: VISION_MODEL, responseModel: data.model, httpStatus: response.status,
    elapsedMs: Date.now() - started,
    usage: { input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens },
    image: { source: 'synthetic PNG; no screenshot', width: SYNTHETIC_SCENE.width, height: SYNTHETIC_SCENE.height },
    observed: { shape: observed.shape, color: observed.color, center: { x: observed.center.x, y: observed.center.y } },
    expectedCenter: SYNTHETIC_SCENE.center, centerErrorPx: Number(distance.toFixed(3)), tolerancePx: SYNTHETIC_SCENE.tolerancePx,
    scope: 'Synthetic-image vision smoke test only; does not validate game state, Jev decisions or native actions.'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const reportPath = path.join(root, 'temp', 'opus-smoke-result.json');
  try {
    fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'temp', 'opus-smoke-synthetic.png'), createSyntheticPng());
    const report = await runOpusSmoke();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    // Do not print provider bodies, malformed config fragments or arbitrary fetch errors.
    const report = { testedAt: new Date().toISOString(), passed: false, error: error instanceof SmokeTestError ? error.message : 'Unable to complete the synthetic-image smoke test', causeCode: error.cause?.code };
    try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); } catch { /* CLI still reports the failure. */ }
    console.error(JSON.stringify(report));
    process.exitCode = 1;
  }
}
