import fs from 'node:fs';
import path from 'node:path';
import { completeCombat, fixtureCard, withContext } from '../test/fixtures/context.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { DecisionMemory } from '../src/decision_context.mjs';

// Synthetic/offline only: exercises packing and validation, never the game/API.
const combat = completeCombat();
combat.decision_context.master_deck = Array.from({ length: 30 }, (_, i) => fixtureCard(i % 3 ? 'STRIKE_IRONCLAD' : 'DEFEND_IRONCLAD', { details: { instance_id: `synthetic-deck-${i}`, upgrade_level: 0 } }));
combat.decision_context.player.deck_count = combat.combat.player.deck_count = 30;
const nodes = Array.from({ length: 54 }, (_, i) => ({ col: i % 3, row: Math.floor(i / 3), type: i % 13 === 0 ? 'REST_SITE' : i % 9 === 0 ? 'ELITE' : i % 7 === 0 ? 'UNKNOWN' : 'MONSTER', children: i < 51 ? [{ col: i % 3, row: Math.floor(i / 3) + 1 }, { col: (i + 1) % 3, row: Math.floor(i / 3) + 1 }] : [{ col: 0, row: 18 }] }));
nodes.push({ col: 0, row: 18, type: 'BOSS', children: [] });
combat.decision_context.map.nodes = nodes;
combat.decision_context.combat_history = Array.from({ length: 100 }, (_, sequence) => ({ sequence, round: 1 + Math.floor(sequence / 35), side: 'Player', actor_id: 0, type: ['CardDrawnEntry', 'CardPlayStartedEntry', 'DamageReceivedEntry', 'CardPlayFinishedEntry'][sequence % 4], card_id: 'STRIKE_IRONCLAD', card_instance_id: 'synthetic-observed-card', description: 'Observed Strike play or draw; dealt 6 damage when played.' }));
const memory = new DecisionMemory(); memory.observe(combat);
for (let i = 0; i < 12; i++) {
  memory.begin({ cmd: 'play_card', id: 'STRIKE_IRONCLAD', nth: 0, target: 42 }, combat);
  memory.finish({ ok: true, data: { results: [{ type: 'damage', hp_loss: 6, target_id: 42 }] } }, combat);
}
const map = withContext({ screen: 'MAP', map: { nodes, travelable_coords: [{ col: 0, row: 0 }, { col: 1, row: 0 }] } }, { map: combat.decision_context.map });
const records = [];
for (const [name, state, stateMemory] of [['combat_30_deck_cards_55_nodes_100_events_12_actions', combat, memory], ['map_55_nodes_two_choices', map, new DecisionMemory()]]) {
  const durations = [];
  let prepared;
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    prepared = prepareModDecision(state, { memory: stateMemory });
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  records.push({ scenario: name, ...prepared.metrics, iterations: durations.length, preparation_p50_ms: +durations[100].toFixed(3), preparation_p95_ms: +durations[190].toFixed(3) });
}
const result = { kind: 'synthetic_offline_context_benchmark', measured_at: new Date().toISOString(), node: process.version, records, rss_bytes_after_benchmark: process.memoryUsage().rss, model_calls: 0, game_actions: 0, actual_input_tokens: null, note: 'Preparation includes JSON validation/packing only. RSS includes Node and Ajv, not the game. No network latency or real token usage was measured.' };
if (process.argv.includes('--write')) {
  fs.mkdirSync('docs/examples', { recursive: true });
  fs.mkdirSync('docs/evidence/2026-09-20', { recursive: true });
  fs.writeFileSync(path.resolve('docs/examples/decision-context.v1.json'), JSON.stringify(prepareModDecision(completeCombat()).payload, null, 2) + '\n');
  fs.writeFileSync(path.resolve('docs/evidence/2026-09-20/context-benchmark.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
