import fs from 'node:fs';
import { ModClient } from '../src/mod_client.mjs';
import { runModLoop } from '../src/mod_loop.mjs';
import { BossRecording } from '../src/boss_recording.mjs';

const ffmpeg = process.argv[2] || process.env.FFMPEG_PATH;
if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('Usage: node --use-system-ca scripts/run_recorded.mjs <ffmpeg.exe>');
fs.mkdirSync('temp', { recursive: true });
const logfile = 'temp/fullrun-live.log', stopfile = 'temp/stop-game-loop';
if (fs.existsSync(stopfile)) throw new Error('A stop request already exists');
fs.writeFileSync(logfile, '');
const controller = new AbortController();
const logger = line => {
  fs.appendFileSync(logfile, `${line}\n`);
  if (fs.existsSync(stopfile)) controller.abort();
};
process.once('SIGINT', () => controller.abort());
const recorder = new BossRecording({ ffmpeg, logger });
const client = new ModClient();
try {
  const result = await runModLoop({ client, maxSteps: 3000, memoryFile: 'run-artifacts/mod-memory.json', signal: controller.signal,
    logger, onBeforeAction: (state, decision) => recorder.beforeAction(state, decision), onObservation: state => recorder.observe(state) });
  logger(JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally { client.close(); }
