import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { expandRecordTables } from '../src/decision_context.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';

// Offline only: same source-to-packet and final compiler as production;
// deliberately no client, credentials, memory writes or model/game calls.
const { values, positionals } = parseArgs({ options: { output: { type: 'string' } }, allowPositionals: true });
if (!values.output || !positionals.length) throw new Error('Usage: node scripts/audit_combat_context.mjs --output <directory> <session-directory> [...]');
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
const report = { scope: 'Native combat snapshot → canonical packet → compiled model request. Every supplied combat/player/pile/deck/rule record is verified before encoding; the compiler verifies reversible encoding. No claim that the native extractor exposes every game mechanic or that forecasts fully simulate combat.',
  model_calls: 0, game_commands: 0, sessions: [] };
for (const directory of positionals) {
  const result = { session: path.basename(directory), snapshots: 0, verified: 0, failures: [],
    future_estimates: { bounded: 0, incomplete: 0 }, uncovered_sources: {}, max_request_bytes: 0 };
  const hashes = createHash('sha256');
  let sample;
  for (const name of fs.readdirSync(directory).filter(name => /^step-\d+$/.test(name)).sort()) {
    const file = path.join(directory, name, 'before-state.json');
    if (!fs.existsSync(file)) continue;
    const native = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (native.screen !== 'COMBAT' || !native.combat?.is_player_turn || native.combat.is_player_actions_disabled
      || native.combat.is_combat_ending || native.combat.player.hp <= 0) continue;
    result.snapshots++;
    try {
      const prepared = prepareModDecision(native);
      if (!prepared.payload) throw new Error('Actionable combat did not produce a complete request');
      const compiled = compileModelRequest(prepared.payload);
      const packet = expandRecordTables(compiled.payload.state);
      const receipt = packet.uncertainty.observation_integrity;
      if (!receipt) throw new Error('Missing native integrity receipt');
      hashes.update(`${name}:${receipt.native_snapshot_sha256}\n`);
      result.verified++;
      result.max_request_bytes = Math.max(result.max_request_bytes, compiled.bytes);
      for (const estimate of Object.values(packet.analysis.action_estimates || {})) {
        result.future_estimates[estimate.calculation_coverage.status]++;
        for (const source of estimate.calculation_coverage.uncovered_effects) {
          const key = `${source.category}/${source.source_id}`;
          result.uncovered_sources[key] = (result.uncovered_sources[key] || 0) + 1;
        }
      }
      // Keep the largest actual request for inspection, with its original input.
      if (!sample || compiled.bytes > sample.bytes) sample = { source: file, native, request: compiled.payload, bytes: compiled.bytes };
    } catch (error) { result.failures.push({ step: name, error: error.message, details: error.details }); }
  }
  result.verified_snapshot_index_sha256 = hashes.digest('hex');
  if (sample) {
    const stem = path.join(output, result.session);
    fs.writeFileSync(`${stem}.native.json`, JSON.stringify(sample.native, null, 2) + '\n');
    fs.writeFileSync(`${stem}.request.json`, JSON.stringify(sample.request, null, 2) + '\n');
    result.sample = { source: sample.source, native: `${result.session}.native.json`, request: `${result.session}.request.json` };
  }
  report.sessions.push(result);
  console.log(JSON.stringify({ session: result.session, snapshots: result.snapshots, verified: result.verified, failures: result.failures.length, max_request_bytes: result.max_request_bytes }));
}
report.totals = report.sessions.reduce((total, session) => ({ snapshots: total.snapshots + session.snapshots,
  verified: total.verified + session.verified, failures: total.failures + session.failures.length }), { snapshots: 0, verified: 0, failures: 0 });
fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, ...report.totals }));
if (report.totals.failures || !report.totals.snapshots) process.exitCode = 1;
