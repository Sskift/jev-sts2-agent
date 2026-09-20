import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { saveRecordingJson } from '../src/recording_files.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const partial = config.output.replace(/\.mp4$/, '.partial.mp4');
const log = fs.createWriteStream(config.output.replace(/\.mp4$/, '.ffmpeg.log'));
let state = { status: 'starting', output: config.output, partial, startedAt: new Date().toISOString(), worker_pid: process.pid };
const save = () => saveRecordingJson(config.job, state);
save();
try {
  const child = spawn(config.ffmpeg, ['-hide_banner', '-y', '-stats_period', '1', '-progress', 'pipe:3',
    '-filter_complex', `gfxcapture=hwnd=${config.hwnd}:capture_cursor=0:max_framerate=20:width=1280:height=720:resize_mode=scale_aspect`,
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '25', '-b:v', '0', '-g', '40', '-an',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', partial],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  state.encoder_pid = child.pid;
  save();
  child.stderr.pipe(log, { end: false });
  let buffer = '';
  child.stdio[3].on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const [key, value] = line.trim().split('=');
      if (key === 'frame' && Number(value) > 0) {
        state.frames = Number(value);
        if (state.status === 'starting') state.status = 'recording';
      }
      if (key === 'out_time') state.duration = value;
      if (key === 'progress') save();
    }
  });
  let stopTimer;
  const timer = setInterval(() => {
    if (!stopTimer && fs.existsSync(config.stop)) {
      state.status = 'stopping'; save();
      stopTimer = setTimeout(() => child.stdin.end('q\n'), 3000);
    }
  }, 250);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearInterval(timer); clearTimeout(stopTimer); }
  if (code !== 0 || !state.frames) throw new Error(`FFmpeg capture exited ${code}; inspect ${log.path}`);
  if (!fs.existsSync(config.stop)) throw new Error('Capture ended before a confirmed boss result; partial video retained');
  const remux = spawn(config.ffmpeg, ['-hide_banner', '-y', '-i', partial, '-c', 'copy', '-movflags', '+faststart', config.output],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  remux.stderr.pipe(log, { end: false });
  const remuxCode = await new Promise((resolve, reject) => { remux.once('error', reject); remux.once('close', resolve); });
  if (remuxCode !== 0) throw new Error(`FFmpeg finalization exited ${remuxCode}; partial video retained`);
  state = { ...state, status: 'complete', finishedAt: new Date().toISOString(), bytes: fs.statSync(config.output).size };
} catch (error) {
  state = { ...state, status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
  process.exitCode = 1;
} finally { save(); log.end(); }
