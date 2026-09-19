import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DRIVER_PROJECT = path.join(ROOT, 'native', 'WindowDriver', 'WindowDriver.csproj');
export const DRIVER_DLL = path.join(ROOT, 'native', 'WindowDriver', 'bin', 'Release', 'net8.0-windows', 'WindowDriver.dll');

/** A single persistent .NET child process; all positions use captured client pixels. */
export class WindowDriver {
  constructor({ titlePattern = 'Slay the Spire 2', hwnd, processId, processName, dllPath = DRIVER_DLL, spawnFn = spawn, timeoutMs = 15000 } = {}) {
    this.selector = hwnd ? { hwnd } : processId ? { processId } : processName ? { processName } : { titleContains: titlePattern };
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
    if (spawnFn === spawn && !fs.existsSync(dllPath)) throw new Error(`Build the native driver first: dotnet build "${DRIVER_PROJECT}" -c Release`);
    this.child = spawnFn('dotnet', [dllPath], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return this.failAll(new Error(`Native driver emitted invalid JSON: ${line.slice(0, 160)}`)); }
      const entry = this.pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(response.id);
      response.ok ? entry.resolve(response.result) : entry.reject(new Error(response.error || 'Native driver failed'));
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    this.child.on('error', error => this.failAll(error));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Native driver exited (${code ?? signal})${this.stderr ? `: ${this.stderr}` : ''}`));
    });
  }

  failAll(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  request(command, args = {}) {
    if (this.closed) return Promise.reject(new Error('Native driver is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Never replay a timed-out action: it may have reached the game already.
        this.pending.delete(id);
        reject(new Error(`Native driver ${command} timed out; execution state is unknown, do not blindly retry`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command, ...this.selector, ...args }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  list() { return this.request('list'); }
  status() { return this.request('status'); }
  restore() { return this.request('restore'); }
  resize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 200 || width > 8192 || height > 8192) {
      return Promise.reject(new Error('Client resize dimensions must be integer pixels between 320x200 and 8192x8192'));
    }
    return this.request('resize', { width, height });
  }
  async capture(outputPath) {
    const result = await this.request('capture', { path: path.resolve(outputPath) });
    if (!result.nonBlank) throw new Error(`Background capture returned a blank surface (${result.path}); cannot use it for vision`);
    return result;
  }
  execute(action) {
    if (!['click', 'drag', 'move', 'key'].includes(action?.type)) return Promise.reject(new Error('Unsupported native action'));
    const args = {};
    for (const key of ['x', 'y', 'endX', 'endY', 'key', 'durationMs', 'expectedWidth', 'expectedHeight']) {
      if (action[key] !== undefined) args[key] = action[key];
    }
    return this.request(action.type, args);
  }
  launch(exe, args = '--windowed --resolution 1280x720') { return this.request('launch', { exe: path.resolve(exe), args }); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.lines.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'list', argument, selector] = process.argv.slice(2);
  const driver = new WindowDriver(selector ? { titlePattern: selector } : {});
  try {
    let result;
    if (command === 'list') result = await driver.list();
    else if (command === 'status') result = await driver.status();
    else if (command === 'capture') result = await driver.capture(argument || path.join(ROOT, 'temp', 'game.png'));
    else throw new Error('CLI supports list, status and capture; actions use the explicit JavaScript API');
    console.log(JSON.stringify(result, null, 2));
  } finally { await driver.close(); }
}
