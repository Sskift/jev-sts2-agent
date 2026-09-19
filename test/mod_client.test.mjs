import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { MOD_PIPE_PATH, ModClient, validateModRequest } from '../src/mod_client.mjs';

async function mockPipe(t, handle) {
  const suffix = `sts2-protocol-test-${randomUUID()}`;
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${suffix}` : path.join(os.tmpdir(), suffix);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) handle(socket, JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
    });
  });
  server.listen(pipePath);
  await once(server, 'listening');
  const client = new ModClient({ pipePath, timeoutMs: 300 });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return client;
}

test('upstream short connections parse UTF8 BOM and fragmented newline responses without correlation IDs', async t => {
  const requests = [];
  const client = await mockPipe(t, (socket, request) => {
    requests.push(request);
    const response = Buffer.from('\uFEFF' + JSON.stringify({ ok: true, data: { screen: 'COMBAT', label: '铁甲战士' } }) + '\r\n');
    socket.write(response.subarray(0, response.length - 6));
    setTimeout(() => socket.end(response.subarray(response.length - 6)), 5);
  });
  assert.equal(MOD_PIPE_PATH, '\\\\.\\pipe\\sts2-cli-mod');
  assert.equal((await client.state()).label, '铁甲战士');
  await client.request({ cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 1, target: 42 });
  assert.deepEqual(requests, [{ cmd: 'state', include_pile_details: false }, { cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 1, target: 42 }]);
  assert.throws(() => validateModRequest({ cmd: 'state', request_id: 12 }), /Unknown/);
  assert.throws(() => validateModRequest({ cmd: 'play_card', id: 12 }), /game ID/);
});

test('structured upstream command errors are preserved rather than reported as success', async t => {
  const rejection = { ok: false, error: 'CARD_NOT_FOUND', message: 'No such card' };
  const client = await mockPipe(t, socket => socket.end(JSON.stringify(rejection) + '\n'));
  assert.deepEqual(await client.request({ cmd: 'play_card', id: 'STRIKE_IRONCLAD' }), rejection);
  await assert.rejects(client.state(), error => error.response?.error === 'CARD_NOT_FOUND');
});

test('malformed envelopes and missing newline are protocol errors', async t => {
  let attempt = 0;
  const client = await mockPipe(t, socket => socket.end(++attempt === 1 ? '{"data":{}}\n' : '{"ok":true}'));
  await assert.rejects(client.ping(), error => error.code === 'INVALID_RESPONSE');
  await assert.rejects(client.ping(), error => error.code === 'INCOMPLETE_RESPONSE');
});

test('timed-out action is sent exactly once and marked outcome unknown', async t => {
  let received = 0;
  const client = await mockPipe(t, () => { received++; });
  await assert.rejects(client.request({ cmd: 'end_turn' }, { timeoutMs: 30 }), error => error.code === 'MOD_TIMEOUT' && error.dispatched && error.outcomeUnknown);
  assert.equal(received, 1);
});
