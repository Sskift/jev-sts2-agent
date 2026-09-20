import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WindowDriver } from './window_driver.mjs';
import { saveRecordingJson as save } from './recording_files.mjs';

const worker = fileURLToPath(new URL('../scripts/record_window.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The worker survives a decision-loop restart so a paused boss fight has no gap.
export class BossRecording {
  constructor({ ffmpeg, manifest = 'run-artifacts/boss-recording.json', logger = console.log } = {}) {
    this.ffmpeg = ffmpeg;
    this.manifest = path.resolve(manifest);
    this.logger = logger;
    fs.mkdirSync(path.dirname(this.manifest), { recursive: true });
    this.data = fs.existsSync(this.manifest) ? read(this.manifest) : { status: 'armed', act_index: 0 };
    save(this.manifest, this.data);
  }

  async beforeAction(state, decision) {
    if (this.data.status !== 'armed' || state.decision_context?.act_index !== 0
      || state.screen !== 'MAP' || decision.request?.cmd !== 'choose_map_node') return;
    const [col, row] = decision.request.args;
    if (state.map?.nodes?.find(node => node.col === col && node.row === row)?.type !== 'BOSS') return;
    if (!this.ffmpeg || !fs.existsSync(this.ffmpeg)) throw new Error('Boss recording requires an existing FFmpeg executable');
    const driver = new WindowDriver({ processName: 'SlayTheSpire2' });
    let status;
    try { status = await driver.status(); } finally { await driver.close(); }
    if (status.window.minimized) throw new Error('Restore the game window before entering the recorded boss fight');
    const directory = path.resolve('run-artifacts', `boss-${Date.now()}`);
    fs.mkdirSync(directory);
    const job = path.join(directory, 'recording.json');
    const config = path.join(directory, 'config.json');
    save(config, { ffmpeg: path.resolve(this.ffmpeg), hwnd: status.window.hwnd,
      output: path.join(directory, 'act1-boss.mp4'), job, stop: path.join(directory, 'stop'),
      run_id: state.decision_context.run_id, window: status });
    const workerLog = fs.openSync(path.join(directory, 'worker.log'), 'a');
    const child = spawn(process.execPath, [worker, config], { detached: true, windowsHide: true, stdio: ['ignore', workerLog, workerLog] });
    fs.closeSync(workerLog);
    child.unref();
    this.data = { ...this.data, status: 'starting', run_id: state.decision_context.run_id, job, config, worker_pid: child.pid };
    save(this.manifest, this.data);
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = fs.existsSync(job) ? read(job) : null;
      if (result?.status === 'recording') {
        this.data.status = 'recording';
        save(this.manifest, this.data);
        this.logger(`Boss recording started: ${result.output}`);
        return;
      }
      if (result?.status === 'failed') throw new Error(`Boss recorder failed: ${result.error}`);
      await sleep(100);
    }
    throw new Error('Boss recorder did not confirm its first frames; map action was not sent');
  }

  async observe(state) {
    if (!['starting', 'recording', 'stopping'].includes(this.data.status)) return;
    const job = fs.existsSync(this.data.job) ? read(this.data.job) : null;
    if (job && !['failed', 'complete'].includes(job.status)) {
      try { process.kill(job.worker_pid, 0); }
      catch { throw new Error(`Boss recording worker exited unexpectedly; inspect ${this.data.job}`); }
    }
    if (job?.status === 'failed') throw new Error(`Boss recording failed: ${job.error}`);
    if (job?.status === 'complete') {
      this.data = { ...this.data, status: 'complete', output: job.output, finishedAt: job.finishedAt };
      save(this.manifest, this.data);
      this.logger(`Boss recording saved: ${job.output}`);
      return;
    }
    if (state.decision_context?.run_id !== this.data.run_id) throw new Error('Run changed while boss recording was active');
    if (state.screen === 'COMBAT' && !this.data.saw_combat) {
      this.data.saw_combat = true;
      this.data.encounter = state.combat?.encounter;
      save(this.manifest, this.data);
    }
    if (this.data.saw_combat && (state.screen === 'REWARD' || state.screen === 'GAME_OVER' || state.decision_context?.act_index > 0)) {
      const config = read(this.data.config);
      if (this.data.status !== 'stopping') {
        this.data.status = 'stopping';
        this.data.result_screen = state.screen;
        this.data.hp = state.decision_context?.player?.hp;
        save(this.manifest, this.data);
        fs.writeFileSync(config.stop, 'Combat ended; keep three seconds of the result.\n');
      }
      for (let attempt = 0; attempt < 300; attempt++) {
        const finished = read(this.data.job);
        if (finished.status === 'failed') throw new Error(`Boss recording failed: ${finished.error}`);
        if (finished.status === 'complete') return this.observe(state);
        await sleep(100);
      }
      throw new Error('Boss recording finalization is still pending; inspect recorder before resuming');
    }
  }
}
