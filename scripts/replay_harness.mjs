import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DecisionMemory } from '../src/decision_context.mjs';
import { rememberRunStrategy } from '../src/run_strategy_state.mjs';

// Offline observations -> model decision only. This script has no game client
// or command dispatcher. It never reads post-cutoff data into model context.
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const args = process.argv.slice(2), mode = args.shift();
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = path.resolve(option('--artifacts') || 'run-artifacts');
const output = path.resolve(option('--output') || 'run-artifacts/harness-evaluation');
const splitFile = option('--split') ? path.resolve(option('--split')) : new URL('../eval/harness-split.json', import.meta.url);
const split = read(splitFile);

function sessions(runId) {
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => path.join(root, e.name)).filter(dir => fs.existsSync(path.join(dir, 'session.json')))
    .filter(dir => read(path.join(dir, 'session.json')).run?.runId === runId).sort();
}
function steps(runId) {
  return sessions(runId).flatMap(dir => fs.readdirSync(dir).filter(name => /^step-\d+$/.test(name)).sort().map(name => path.join(dir, name)))
    .filter(dir => fs.existsSync(path.join(dir, 'before-state.json')));
}
function snapshot(dir, id, cohort) {
  const state = read(path.join(dir, 'before-state.json'));
  const memory = new DecisionMemory();
  let reachedCutoff = false;
  for (const prior of steps(state.decision_context.run_id)) {
    if (prior === dir) { reachedCutoff = true; break; }
    const before = read(path.join(prior, 'before-state.json'));
    memory.observe(before);
    const strategy = path.join(prior, 'run-strategy-decision.json');
    if (fs.existsSync(strategy)) {
      const assessment = read(strategy);
      rememberRunStrategy(memory, before, assessment, assessment.reason);
    }
    const responseFile = path.join(prior, 'response.json'), afterFile = path.join(prior, 'after-state.json'), decisionFile = path.join(prior, 'decision.json');
    if (![responseFile, afterFile, decisionFile].every(fs.existsSync)) continue;
    const decision = read(decisionFile), response = read(responseFile);
    if (decision.action !== 'mod_command') continue;
    memory.begin(decision.request, before, { turnPlan: decision.turn_plan, turnStep: decision.turn_step, campUpgradePlan: decision.camp_upgrade_plan });
    const after = read(afterFile);
    memory.finish(response, after); memory.observe(after);
  }
  if (!reachedCutoff) throw new Error('Snapshot is outside its declared run history');
  memory.observe(state);
  if (memory.data.pending) throw new Error('Replay cutoff has an unconfirmed action');
  const modelInput = { state, memory: memory.data };
  const result = { id, cohort, source: path.relative(process.cwd(), dir).replaceAll('\\', '/'),
    input_sha256: hash(JSON.stringify(modelInput)), ...modelInput };
  write(path.join(output, 'cases', `${id}.json`), result);
  console.log(JSON.stringify({ id, cohort, floor: state.decision_context.total_floor, turn: state.combat?.turn_number, input_sha256: result.input_sha256 }));
}

if (mode === 'collect') {
  const cohort = option('--cohort') || 'development';
  if (cohort === 'holdout') {
    if (!fs.existsSync(path.join(output, 'freeze.json'))) throw new Error('Freeze candidate source before selecting holdout snapshots');
    for (const [index, run] of split.holdout_runs.entries()) {
      const dirs = steps(run);
      const records = dirs.map(dir => ({ dir, state: read(path.join(dir, 'before-state.json')) })).filter(({state}) => state.screen === 'COMBAT');
      const encounters = [...new Set(records.map(({state}) => state.decision_context.combat_id))].reverse();
      const turns = split.holdout_turns || [1, 3], rejected = [];
      const { prepareModDecision } = await import('../src/mod_decision.mjs');
      let selected;
      for (const combatId of split.compatible_encounter ? encounters : encounters.slice(0, 1)) {
        const candidates = turns.map(turn => records.find(({ state: s }) => s.decision_context.combat_id === combatId
          && s.combat.turn_number === turn && s.combat.is_player_turn && !s.combat.is_player_actions_disabled && s.combat.hand.some(c => c.can_play)));
        try {
          if (candidates.some(c => !c)) throw new Error('Missing declared actionable turn');
          if (split.compatible_encounter) for (const {state} of candidates) prepareModDecision(state);
          selected = candidates; break;
        } catch(error) { rejected.push({ combat_id: combatId, reason: error.message }); }
      }
      if (!selected) throw new Error(`Missing compatible predeclared holdout ${run}`);
      write(path.join(output, `selection-${run}.json`), { run, rejected, selected: selected.map(({dir,state}) => ({ source: path.relative(process.cwd(),dir), floor: state.decision_context.total_floor, turn: state.combat.turn_number })) });
      for (const {dir,state} of selected) snapshot(dir, `holdout-${split.holdout_run_numbers?.[index] ?? 20 + index}-turn-${state.combat.turn_number}`, cohort);
    }
  } else {
    const dir = path.resolve(option('--step') || '');
    const state = read(path.join(dir, 'before-state.json'));
    if (!split.development_runs.includes(state.decision_context.run_id)) throw new Error('Not a declared development run');
    snapshot(dir, option('--id') || 'development', cohort);
  }
} else if (mode === 'freeze') {
  const files = ['scripts/replay_harness.mjs', option('--split') || 'eval/harness-split.json', ...['src', 'schemas', 'data'].flatMap(dir => fs.readdirSync(dir, { recursive: true }).filter(f => /\.(mjs|json)$/.test(f)).map(f => path.join(dir, f)))].sort();
  const hashes = Object.fromEntries(files.map(f => [f.replaceAll('\\', '/'), hash(fs.readFileSync(f))]));
  const frozen = { at: new Date().toISOString(), baseline_commit: split.baseline_commit, candidate_sha256: hash(JSON.stringify(hashes)), files: hashes };
  if (fs.existsSync(path.join(output, 'freeze.json'))) throw new Error('Freeze already exists; retain the original assessment instead of overwriting it');
  write(path.join(output, 'freeze.json'), frozen);
  console.log(JSON.stringify({ candidate_sha256: frozen.candidate_sha256 }));
} else if (mode === 'replay') {
  const fixture = read(path.resolve(option('--case'))), codeRoot = path.resolve(option('--code') || '.');
  const source = hash(JSON.stringify({ state: fixture.state, memory: fixture.memory }));
  if (source !== fixture.input_sha256) throw new Error('Replay input hash changed');
  if (fixture.cohort === 'holdout' && codeRoot === process.cwd()) {
    const frozen = read(path.join(output, 'freeze.json'));
    for (const [file, expected] of Object.entries(frozen.files)) if (hash(fs.readFileSync(file)) !== expected) throw new Error(`Candidate changed after freeze: ${file}`);
  }
  const { makeModDecisionWithJev } = await import(pathToFileURL(path.join(codeRoot, 'src/mod_decision.mjs')));
  const { DecisionMemory: Memory } = await import(pathToFileURL(path.join(codeRoot, 'src/decision_context.mjs')));
  const label = option('--label') || (codeRoot === process.cwd() ? 'candidate' : 'baseline');
  const repetitions = Number(option('--repeat') || 1);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('--repeat must be a positive integer');
  for (let repeat = 1; repeat <= repetitions; repeat++) {
    const dir = path.join(output, 'results', fixture.id, label, String(repeat));
    if (fs.existsSync(path.join(dir, 'summary.json'))) throw new Error(`Result already exists: ${dir}`);
    const memory = new Memory(); memory.data = structuredClone(fixture.memory);
    let calls = 0, responses = 0, started = performance.now();
    const summary = { id: fixture.id, cohort: fixture.cohort, label, repeat, input_sha256: source, code_root: codeRoot };
    try {
      const result = await makeModDecisionWithJev(structuredClone(fixture.state), { memory, runStrategy: false,
        onRequest(payload, metrics) {
          write(path.join(dir, `request-${++calls}.json`), { purpose: metrics.purpose,
            transport: { provider: metrics.provider, requested_model: metrics.requested_model, attempt: metrics.attempt, failover: metrics.failover }, ...payload });
          return calls;
        },
        onResponse(result, _metrics, traceId) { responses++; write(path.join(dir, `response-${traceId}.json`), result); }
      });
      write(path.join(dir, 'decision.json'), result);
      Object.assign(summary, { request: result.request, objective: result.turn_plan?.objective, model: result.planning_model || result.model,
        sequence: result.turn_plan?.steps.map(s => ({ kind: s.kind, name: s.name, card_id: s.card_id, target: s.target, slot: s.slot })),
        candidate_coverage: result.turn_plan?.candidate_coverage, assessment_shortlist: result.turn_plan?.assessment_shortlist, comparison_audit: result.turn_plan?.comparison_audit,
        usage: result.usage, calls, responses, elapsed_ms: Math.round(performance.now() - started) });
    } catch (error) { Object.assign(summary, { error: error.message, details: error.details, calls, responses }); }
    write(path.join(dir, 'summary.json'), summary); console.log(JSON.stringify(summary));
    if (summary.error) process.exitCode = 1;
  }
} else throw new Error('Usage: replay_harness.mjs collect|freeze|replay [--step DIR --id ID | --case FILE --code ROOT --repeat N]');
