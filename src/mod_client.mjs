import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOD_PIPE_PATH = '\\\\.\\pipe\\sts2-cli-mod';
const REQUEST_FIELDS = new Set(['cmd', 'args', 'target', 'id', 'nth', 'reward_type', 'card_id', 'card_ids', 'nth_values', 'skip', 'include_pile_details']);

/** Matches upstream Models/Messages/Request.cs. `id` identifies a game object. */
export function validateModRequest(request) {
  if (!request || typeof request.cmd !== 'string' || !/^[a-z][a-z_]*$/.test(request.cmd)) throw new Error('Mod request needs a lowercase cmd');
  for (const [key, value] of Object.entries(request)) {
    if (!REQUEST_FIELDS.has(key)) throw new Error(`Unknown mod request field: ${key}`);
    if (value == null) continue;
    if (['id', 'reward_type', 'card_id'].includes(key) && typeof value !== 'string') throw new Error(`Mod ${key} must be a string game ID, not a request correlation ID`);
    if (['target', 'nth'].includes(key) && (!Number.isInteger(value) || value < 0 || value > 2147483647)) throw new Error(`Invalid mod ${key}`);
    if (['args', 'nth_values'].includes(key) && (!Array.isArray(value) || value.some(item => !Number.isInteger(item) || item < (key === 'nth_values' ? 0 : -2147483648) || item > 2147483647))) throw new Error(`Invalid mod ${key}`);
    if (key === 'card_ids' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error('Invalid mod card_ids');
    if (['skip', 'include_pile_details'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid mod ${key}`);
  }
  return request;
}

export class ModTransportError extends Error {
  constructor(message, { code = 'MOD_TRANSPORT_ERROR', request, dispatched = false } = {}) {
    super(message);
    this.name = 'ModTransportError';
    this.code = code;
    this.request = request;
    this.dispatched = dispatched;
    this.outcomeUnknown = dispatched && !['state', 'ping', 'view_deck'].includes(request?.cmd);
  }
}

/**
 * Upstream PipeServer.cs uses one UTF-8 JSON line per connection, then closes.
 * There is no request ID or multiplexing. Every request opens a fresh connection;
 * local calls are serialized and transport failures are NEVER automatically replayed.
 */
export class ModClient {
  constructor({ pipePath = MOD_PIPE_PATH, timeoutMs = 30000, maxResponseBytes = 8 * 1024 * 1024, connect = net.createConnection } = {}) {
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.connect = connect;
    this.queue = Promise.resolve();
    this.closed = false;
    this.sockets = new Set();
  }

  request(request, { timeoutMs = this.timeoutMs } = {}) {
    validateModRequest(request);
    const snapshot = JSON.parse(JSON.stringify(request));
    const operation = this.queue.then(() => this.send(snapshot, timeoutMs));
    this.queue = operation.catch(() => {});
    return operation;
  }

  send(request, timeoutMs) {
    if (this.closed) return Promise.reject(new ModTransportError('Mod client is closed', { code: 'CLIENT_CLOSED', request }));
    return new Promise((resolve, reject) => {
      let socket, settled = false, dispatched = false, buffer = '', responseBytes = 0;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) { this.sockets.delete(socket); socket.destroy(); }
        error ? reject(error) : resolve(response);
      };
      const fail = (message, code) => finish(new ModTransportError(message, { code, request, dispatched }));
      const timer = setTimeout(() => fail(`Mod ${request.cmd} timed out; ${dispatched ? 'request was sent and will not be retried' : 'no request was sent'}`, 'MOD_TIMEOUT'), timeoutMs);
      try {
        socket = this.connect({ path: this.pipePath });
        this.sockets.add(socket);
        socket.setEncoding('utf8');
        socket.once('connect', () => {
          if (settled) return;
          dispatched = true;
          socket.write(JSON.stringify(request) + '\n');
        });
        socket.on('data', chunk => {
          responseBytes += Buffer.byteLength(chunk, 'utf8');
          if (responseBytes > this.maxResponseBytes) return fail('Mod response exceeds byte limit', 'INVALID_RESPONSE');
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          try {
            const line = buffer.slice(0, newline).replace(/^\uFEFF/, '').trim();
            const response = JSON.parse(line);
            if (!response || typeof response.ok !== 'boolean' || buffer.slice(newline + 1).trim()) return fail('Invalid mod response envelope or framing', 'INVALID_RESPONSE');
            finish(null, response);
          } catch { fail('Mod response is not a complete JSON object', 'INVALID_RESPONSE'); }
        });
        socket.once('error', error => fail(`Mod pipe error: ${error.code || error.message}`, error.code || 'MOD_PIPE_ERROR'));
        socket.once('end', () => fail('Mod pipe ended without a newline-terminated response', 'INCOMPLETE_RESPONSE'));
        socket.once('close', () => fail('Mod pipe closed without a response', 'INCOMPLETE_RESPONSE'));
      } catch (error) { fail(`Cannot connect to mod pipe: ${error.message}`, 'MOD_PIPE_ERROR'); }
    });
  }

  async state({ includePileDetails = false, timeoutMs = this.timeoutMs } = {}) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.request({ cmd: 'state', include_pile_details: includePileDetails }, { timeoutMs });
        break;
      } catch (error) {
        // The server creates a new short-lived pipe after each response. A read
        // can briefly race its recreation. Only read-only state is retried.
        if (!(error instanceof ModTransportError) || error.code !== 'MOD_PIPE_ERROR' || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    if (!response.ok) {
      const error = new Error(`Mod state failed: ${response.error || 'UNKNOWN'}: ${response.message || ''}`);
      error.response = response;
      throw error;
    }
    if (!response.data || typeof response.data.screen !== 'string' || response.data.error) throw new Error(`Mod state extraction failed: ${response.data?.error || 'missing screen'}`);
    return response.data;
  }

  ping(options) { return this.request({ cmd: 'ping' }, options); }
  close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy(new Error('Mod client closed'));
    this.sockets.clear();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = new ModClient();
  try {
    const cmd = process.argv[2] || 'state';
    if (!['state', 'ping', 'view_deck'].includes(cmd)) throw new Error('Read-only CLI supports state, ping and view_deck');
    console.log(JSON.stringify(await client.request({ cmd }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { client.close(); }
}
