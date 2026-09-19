import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WindowDriver } from '../src/window_driver.mjs';

function fixture(onRequest, options = {}) {
  const requests = [];
  let child;
  const spawnFn = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', buffer => {
      for (const line of buffer.toString().trim().split('\n')) {
        const request = JSON.parse(line); requests.push(request);
        onRequest?.(request, response => child.stdout.write(JSON.stringify({ id: request.id, ...response }) + '\n'));
      }
    });
    child.stdin.on('finish', () => { child.stdout.end(); child.emit('exit', 0, null); });
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    return child;
  };
  return { driver: new WindowDriver({ spawnFn, ...options }), requests };
}

test('persistent driver correlates multiple requests with client-coordinate status', async () => {
  const replies = [];
  const { driver, requests } = fixture((request, reply) => replies.push({ request, reply }), { hwnd: '0x1234' });
  try {
    const first = driver.status(); const second = driver.list();
    replies[1].reply({ ok: true, result: ['window'] });
    replies[0].reply({ ok: true, result: { hwnd: '0x1234', width: 1280, height: 720 } });
    assert.deepEqual(await first, { hwnd: '0x1234', width: 1280, height: 720 });
    assert.deepEqual(await second, ['window']);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].hwnd, '0x1234');
  } finally { await driver.close(); }
});

test('action payload cannot redirect input to another window or command', async () => {
  const { driver, requests } = fixture((request, reply) => reply({ ok: true, result: { foregroundUnchanged: true, cursorUnchanged: true } }), { hwnd: '0x1234' });
  try {
    await driver.execute({ type: 'click', x: 40, y: 50, expectedWidth: 1280, expectedHeight: 720, hwnd: '0xBAD', command: 'launch', id: 99 });
    assert.deepEqual(requests[0], { id: 1, command: 'click', hwnd: '0x1234', x: 40, y: 50, expectedWidth: 1280, expectedHeight: 720 });
  } finally { await driver.close(); }
});

test('blank GPU capture is rejected before vision can consume it', async () => {
  const { driver } = fixture((request, reply) => reply({ ok: true, result: { path: request.path, nonBlank: false } }));
  try { await assert.rejects(driver.capture('temp/blank.png'), /blank surface/); }
  finally { await driver.close(); }
});

test('timeout rejects without replaying an action with unknown execution state', async () => {
  const { driver, requests } = fixture(() => {}, { timeoutMs: 15 });
  try {
    await assert.rejects(driver.execute({ type: 'click', x: 2, y: 3 }), /execution state is unknown/);
    assert.equal(requests.length, 1);
  } finally { await driver.close(); }
});

test('native errors reject and closing the helper prevents later input', async () => {
  const { driver } = fixture((request, reply) => reply({ ok: false, error: 'Window client size changed since capture' }));
  await assert.rejects(driver.execute({ type: 'click', x: 2, y: 3 }), /size changed/);
  await driver.close();
  await assert.rejects(driver.status(), /closed/);
});

test('resize addresses the chosen HWND and reports actual client pixels and desktop invariants', async () => {
  const nativeResult = { hwnd: '0x1234', width: 1280, height: 720, sizeMatched: true, foregroundUnchanged: true, cursorUnchanged: true };
  const { driver, requests } = fixture((request, reply) => reply({ ok: true, result: nativeResult }), { hwnd: '0x1234' });
  try {
    assert.deepEqual(await driver.resize(1280, 720), nativeResult);
    assert.deepEqual(requests[0], { id: 1, command: 'resize', hwnd: '0x1234', width: 1280, height: 720 });
    await assert.rejects(driver.resize(-1, 720), /resize dimensions/);
    await assert.rejects(driver.resize(1280, 720.5), /resize dimensions/);
    assert.equal(requests.length, 1);
  } finally { await driver.close(); }
});
