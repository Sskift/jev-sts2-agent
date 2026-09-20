import test from 'node:test';
import assert from 'node:assert/strict';
import { combatForecast } from '../src/combat_arithmetic.mjs';
import { describeTurnProjection } from '../src/turn_projection.mjs';
import { visibleSurvivalConstraints } from '../src/turn_plan_comparison.mjs';
import { prepareModDecision } from '../src/mod_decision.mjs';
import { compileModelRequest } from '../src/context_compiler.mjs';
import { completeCombat } from './fixtures/context.mjs';

function state() {
  const s = completeCombat();
  Object.assign(s.combat.player, { hp: 10, block: 0, energy: 3 });
  Object.assign(s.combat.enemies[0], { hp: 3, block: 0, intents: [], powers: [
    { id: 'THORNS_POWER', amount: 5, description: 'When hit by an attack, deal 5 damage back.' }
  ] });
  Object.assign(s.combat.hand[0], { attack_preview: { hits: 3 }, damage: 6, target_previews: [{ target_id: 42, damage: 6 }] });
  s.decision_context.player = structuredClone(s.combat.player);
  return s;
}

test('Thorns exposes per-hit timing even on a lethal preview and invalidates HP/Block outcomes', () => {
  const s = state(), c = s.combat, card = c.hand[0];
  const result = combatForecast(c, card, c.enemies[0]);
  assert.equal(result.hp_remaining_if_end_turn, null, 'Previewed kill cannot prove safe survival');
  assert.equal(result.fatal_if_end_turn, null, 'Exposure is not proof all hits occur');
  assert.equal(result.block_after_card, null);
  assert.equal(result.displayed_attacks_after_target_depletion, null);
  assert.equal(result.uncomputed_reactions[0].damage_if_all_preview_hits_resolve, 15);
  assert.equal(result.uncomputed_reactions[0].timing, 'before_each_qualifying_damage_instance');
  const original = structuredClone(s);
  const projected = describeTurnProjection(s, [{ kind: 'play_card', name: card.name, card_instance_id: card.details.instance_id, target: 42 }]);
  assert.equal(projected.calculation_status, 'incomplete');
  assert.equal(projected.known_effects_only.hp_if_ending, null);
  assert.equal(projected.known_effects_only.block, null);
  assert.equal(projected.uncomputed_reactions[0].sequence, 0);
  assert.deepEqual(s, original);
  const prepared = prepareModDecision(s);
  prepared.payload.state.turn_planning = { phase_scope: 'reaction fixture', energy_reservation: {
    observed_energy: 3, remaining_after_printed_costs: 3, scope: 'fixture', is_observed: false, includes_future_energy_gains: false, steps: []
  }, conditional_projection: projected };
  assert.doesNotThrow(() => compileModelRequest(prepared.payload));
});

test('non-hits do not invent retaliation; unknown X counts remain unknown; Omnislice is included', () => {
  const s = state(), c = s.combat, card = c.hand[0], enemy = c.enemies[0];
  assert.equal(combatForecast(c).uncomputed_reactions, undefined);
  assert.equal(combatForecast(c, { ...card, attack_preview: { hits: 0 } }, enemy).uncomputed_reactions, undefined);
  assert.equal(combatForecast(c, { ...card, type: 'Skill' }, enemy).uncomputed_reactions, undefined);
  const unknown = combatForecast(c, { ...card, cost: -1, attack_preview: undefined }, enemy);
  assert.equal(unknown.uncomputed_reactions[0].preview_hits, null);
  assert.equal(unknown.uncomputed_reactions[0].damage_if_all_preview_hits_resolve, null);
  assert.equal(combatForecast(c, { ...card, id: 'OMNISLICE', type: 'Skill' }, enemy).uncomputed_reactions.length, 1);
  enemy.block = 100;
  assert.equal(combatForecast(c, card, enemy).uncomputed_reactions.length, 1, 'Thorns does not require unblocked damage');
});

test('survival exposure accounts for reactions without prioritizing harmless ordinary mitigation', () => {
  const s = state();
  const constraint = visibleSurvivalConstraints(s).find(item => item.kind === 'potential_lethal_health_loss');
  assert.equal(constraint.displayed_attacks_before_block, 0);
  assert.equal(constraint.hand_preview_reaction_exposure, 15);
  s.combat.player.hp = 80;
  assert.equal(visibleSurvivalConstraints(s).length, 0);
  s.combat.player.hp = 20;
  s.combat.enemies.push({ ...structuredClone(s.combat.enemies[0]), combat_id: 43 });
  assert.equal(visibleSurvivalConstraints(s).length, 0, 'Single-target alternatives must not be counted as hitting both');
  s.combat.hand[0].target_type = 'AllEnemies';
  assert.equal(visibleSurvivalConstraints(s)[0].hand_preview_reaction_exposure, 30);
});
