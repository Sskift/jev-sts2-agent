import test from 'node:test';
import assert from 'node:assert/strict';
import { combatForecast, firstHitHpLoss, attackHpLoss, immediateBlockPreview } from '../src/combat_arithmetic.mjs';

test('missing native Block uses only an unconditional resolved first sentence and never guesses conditional effects', () => {
  const card = { id: 'EXPECT_A_FIGHT', type: 'Skill', cost: 3, description: 'Gain 25 Block. Gains 5 additional Block for each Strength you have.' };
  const combat = { player: { hp: 26, block: 0, energy: 3 }, hand: [card], enemies: [{ combat_id: 1, hp: 50, block: 0, is_alive: true, intents: [{ damage: 28, hits: 1 }] }] };
  const result = combatForecast(combat, card);
  assert.equal(result.block_after_card, 25);
  assert.equal(result.hp_remaining_if_end_turn, 23);
  assert.equal(result.block_preview.source, 'resolved_live_first_sentence');
  assert.equal(immediateBlockPreview({ ...card, block: 30 }).amount, 30, 'The authoritative numeric preview wins');
  for (const description of ['If the enemy intends to attack, gain 25 Block.', 'Gain 5 Block for each card in hand.', 'At the start of next turn, gain 25 Block.']) {
    assert.equal(immediateBlockPreview({ ...card, description }).amount, null);
    assert.equal(combatForecast(combat, { ...card, description }).fatal_if_end_turn, null);
  }
  assert.equal(immediateBlockPreview({ ...card, id: 'RAGE', description: 'Whenever you play an Attack, gain 3 Block.' }).amount, 0);
  assert.equal(immediateBlockPreview({ ...card, type: 'Power' }).amount, 0);
});

test('visible damage caps prevent a false lethal and defensive arithmetic exposes survival', () => {
  const enemy = { combat_id: 1, hp: 15, block: 0, is_alive: true, powers: [{ id: 'SLIPPERY_POWER', amount: 1, name: 'Slippery' }], intents: [{ damage: 2, hits: 3 }] };
  const combat = { player: { hp: 5, block: 0, energy: 2 }, enemies: [enemy, { combat_id: 2, hp: 16, block: 0, is_alive: true, intents: [{ damage: 3, hits: 1 }] }] };
  const bash = { cost: 2, target_previews: [{ target_id: 1, damage: 18 }] };
  assert.equal(firstHitHpLoss(bash, enemy).hp_loss, 1);
  assert.equal(combatForecast(combat, bash, enemy).fatal_if_end_turn, true);
  const defend = combatForecast(combat, { cost: 1, block: 8 });
  assert.equal(defend.hp_remaining_if_end_turn, 4);
  assert.equal(defend.fatal_if_end_turn, false);
  assert.equal(defend.energy_after_printed_cost, 1);
  enemy.powers = [];
  assert.equal(combatForecast(combat, bash, enemy).hp_remaining_if_end_turn, 2);
});

test('an inexpensive first hit leaves enough energy to finish a target after consuming Slippery', () => {
  const enemy = { combat_id: 1, hp: 16, block: 0, is_alive: true, powers: [{ id: 'SLIPPERY_POWER', amount: 1 }], intents: [{ damage: 8 }] };
  const strike = { index: 0, cost: 1, can_play: true, target_previews: [{ target_id: 1, damage: 9 }] };
  const bigAttack = { index: 1, cost: 2, can_play: true, target_previews: [{ target_id: 1, damage: 30 }] };
  const combat = { player: { hp: 10, block: 0, energy: 3 }, hand: [strike, bigAttack], enemies: [enemy] };
  assert.equal(combatForecast(combat, strike, enemy).followup_attacks.enough_to_deplete_target, true);
  assert.equal(combatForecast(combat, bigAttack, enemy).followup_attacks.enough_to_deplete_target, false);
});

test('Orichalcum and delayed Rage block are not mistaken for immediate block gains', () => {
  const combat = { player: { hp: 10, energy: 3, block: 0, relics: [{ id: 'ORICHALCUM' }] }, hand: [], enemies: [{ is_alive: true, hp: 20, intents: [{ damage: 6 }] }] };
  assert.equal(combatForecast(combat).hp_loss_if_end_turn, 0);
  assert.equal(combatForecast(combat, { cost: 1, block: 5 }).hp_loss_if_end_turn, 1);
  const rage = combatForecast(combat, { id: 'RAGE', cost: 0, block: 3 });
  assert.equal(rage.block_after_card, 0);
  assert.equal(rage.block_including_end_turn_gains, 6);
});

test('active Plating and Orichalcum use native turn-end timing, with no Dexterity or Frail scaling', () => {
  const combat = { player: { hp: 73, energy: 3, block: 0, powers: [
    { id: 'PLATING_POWER', amount: 7 }, { id: 'DEXTERITY_POWER', amount: 2 }, { id: 'FRAIL_POWER', amount: 1 }
  ], relics: [] }, hand: [], enemies: [{ is_alive: true, hp: 28, intents: [{ damage: 7 }] }] };
  const end = combatForecast(combat);
  assert.equal(end.block_after_card, 0);
  assert.equal(end.block_including_end_turn_gains, 7);
  assert.equal(end.hp_remaining_if_end_turn, 73);
  assert.equal(end.end_turn_block_gains[0].source_id, 'PLATING_POWER');
  combat.player.relics.push({ id: 'ORICHALCUM' });
  assert.equal(combatForecast(combat).block_including_end_turn_gains, 13, 'Orichalcum checks zero before Plating triggers');
  assert.equal(combatForecast(combat, { cost: 1, block: 5 }).block_including_end_turn_gains, 12, 'Immediate Block suppresses only Orichalcum');
  combat.player.powers[0].amount = 6;
  assert.equal(combatForecast(combat).block_including_end_turn_gains, 12, 'Use the current observed stack, not the original potion grant');
});

test('Rage exposes an affordable attack sequence as conditional Block without granting it immediately', () => {
  const rage = { index: 0, id: 'RAGE', type: 'Skill', cost: 0, rage_block_per_attack: 3, can_play: true };
  const attack = (index, cost, extra = {}) => ({ index, type: 'Attack', cost, can_play: true, ...extra });
  const combat = { player: { hp: 10, block: 0, energy: 3 }, enemies: [{ is_alive: true, hp: 100, intents: [{ damage: 13 }] }], hand: [rage, attack(1, 1), attack(2, 2), attack(3, 3), attack(4, 0), attack(5, 0, { hp_loss: 2 }), attack(6, -1), attack(7, 0, { can_play: false })] };
  const estimate = combatForecast(combat, rage);
  assert.equal(estimate.block_after_card, 0);
  assert.equal(estimate.fatal_if_end_turn, true);
  assert.deepEqual(estimate.attack_trigger_potential.hand_indices, [1, 2, 4]);
  assert.equal(estimate.attack_trigger_potential.additional_block_if_all_played, 9);
  combat.player.energy = 0;
  assert.deepEqual(combatForecast(combat, rage).attack_trigger_potential.hand_indices, [4]);
  rage.rage_block_per_attack = 5;
  assert.equal(combatForecast(combat, rage).attack_trigger_potential.additional_block_if_all_played, 5, 'Upgraded Rage uses its actual trigger amount, without adding Dexterity');
  delete rage.rage_block_per_attack;
  assert.equal(combatForecast(combat, rage).attack_trigger_potential, null, 'A legacy mod missing the amount cannot claim that Rage grants zero Block');
});

test('active Rage counts once per Attack, even at zero X, without Dexterity or Frail scaling', () => {
  const combat = { player: { hp: 5, block: 0, energy: 0, powers: [
    { id: 'RAGE_POWER', amount: 5 }, { id: 'DEXTERITY_POWER', amount: 10 }, { id: 'FRAIL_POWER', amount: 1 }
  ] }, hand: [], enemies: [{ is_alive: true, hp: 50, intents: [{ damage: 9 }] }] };
  const attack = { type: 'Attack', cost: 0 };
  assert.equal(combatForecast(combat, attack).hp_remaining_if_end_turn, 1);
  assert.equal(combatForecast(combat, attack).active_rage_block_gain, 5);
  assert.equal(combatForecast(combat, { ...attack, cost: -1 }).active_rage_block_gain, 5);
  assert.equal(combatForecast(combat, { ...attack, block: 3 }).block_after_card, 8);
  assert.equal(combatForecast(combat, { type: 'Skill', cost: 0 }).block_after_card, 0);
  assert.equal(combatForecast(combat).block_after_card, 0);
});

test('visible Sandpit instant death overrides safe-looking HP and Block arithmetic', () => {
  const boss = { combat_id: 1, hp: 143, block: 0, is_alive: true, intents: [{ damage: 10, hits: 2 }], powers: [{ id: 'SANDPIT_POWER', amount: 1 }] };
  const combat = { player: { hp: 45, block: 10, energy: 1 }, hand: [], enemies: [boss] };
  assert.equal(combatForecast(combat).instant_death_if_end_turn, true);
  assert.equal(combatForecast(combat).hp_loss_if_end_turn, 45);
  assert.equal(combatForecast(combat, { cost: 1, block: 99 }).hp_remaining_if_end_turn, 0);
  const escaped = combatForecast(combat, { id: 'FRANTIC_ESCAPE', cost: 1 });
  assert.equal(escaped.fatal_if_end_turn, false);
  assert.equal(escaped.death_timers[0].enemy_turns_remaining_after_card, 2);
  const kill = combatForecast(combat, { cost: 1, target_previews: [{ target_id: 1, damage: 143 }] }, boss);
  assert.equal(kill.fatal_if_end_turn, false, 'Killing the countdown owner ends this threat');
  boss.powers[0].amount = 2;
  assert.equal(combatForecast(combat).instant_death_if_end_turn, false);
});

test('Second Wind counts other non-attacks and exposes exhausted setup cards', () => {
  const wind = { id: 'SECOND_WIND', index: 1, type: 'Skill', cost: 1, block: 5 };
  const combat = { player: { hp: 9, block: 6, energy: 2 }, enemies: [{ is_alive: true, hp: 124, intents: [{ damage: 24 }] }], hand: [
    { id: 'PERFECTED_STRIKE', index: 0, type: 'Attack' }, wind,
    { id: 'DEFEND_IRONCLAD', index: 2, type: 'Skill' }, { id: 'DEFEND_IRONCLAD', index: 3, type: 'Skill' }
  ] };
  const forecast = combatForecast(combat, wind);
  assert.equal(forecast.hp_remaining_if_end_turn, 1, 'The recorded boss position is survivable with two exhausted Defends');
  assert.equal(forecast.immediate_block_gain, 10);
  combat.hand = [wind, { id: 'INFLAME', index: 0, type: 'Power' }];
  assert.deepEqual(combatForecast(combat, wind).exhausted_hand_cards, [{ index: 0, id: 'INFLAME', type: 'Power' }]);
  combat.hand = [wind, { index: 0, type: 'Attack' }];
  assert.equal(combatForecast(combat, wind).immediate_block_gain, 0, 'The played card is not itself exhausted');
});

test('an all-enemy attack uses each target preview and preserves surviving or unknown threats', () => {
  const enemies = [
    { combat_id: 1, hp: 6, block: 0, is_alive: true, intents: [{ damage: 10 }] },
    { combat_id: 2, hp: 6, block: 3, is_alive: true, intents: [{ damage: 7 }] },
    { combat_id: 3, hp: 6, block: 0, is_alive: true, intents: [{ damage: 4 }], powers: [{ id: 'SLIPPERY_POWER', amount: 1 }] },
    { combat_id: 4, hp: 6, block: 0, is_alive: true, intents: [{ damage: 2 }] }
  ];
  const combat = { player: { hp: 20, energy: 2, block: 0 }, hand: [], enemies };
  const area = { cost: 1, target_type: 'AllEnemies', target_previews: [1, 2, 3].map(target_id => ({ target_id, damage: 8 })) };
  const estimate = combatForecast(combat, area);
  assert.equal(estimate.hp_remaining_if_end_turn, 7, 'Only the first enemy loses all HP; the other three still threaten damage');
  assert.deepEqual(estimate.attack_hp_loss_by_target.map(p => p.hp_loss), [8, 5, 1, null]);
  assert.deepEqual(estimate.attack_hp_loss_by_target.map(p => p.hp_depleted), [true, false, false, false]);
  assert.equal(combatForecast(combat, { ...area, target_type: 'RandomEnemy' }).hp_remaining_if_end_turn, -3, 'A random-target attack cannot claim to hit every enemy');
});

test('a playable zero-energy X attack must not falsely remove a lethal attacker', () => {
  const enemy = { combat_id: 1, hp: 5, block: 0, is_alive: true, intents: [{ damage: 20 }] };
  const whirlwind = { cost: -1, target_type: 'AllEnemies', can_play: true, target_previews: [{ target_id: 1, damage: 7 }] };
  const combat = { player: { hp: 10, energy: 0, block: 0 }, hand: [whirlwind], enemies: [enemy] };
  const estimate = combatForecast(combat, whirlwind);
  assert.equal(firstHitHpLoss(whirlwind, enemy), null);
  assert.deepEqual(estimate.attack_hp_loss_by_target, [{ target_id: 1, hp_loss: null, hp_depleted: false }]);
  assert.equal(estimate.fatal_if_end_turn, true);
  assert.equal(whirlwind.target_previews[0].damage, 7, 'The real per-hit preview remains available to Jev');
});

test('known repeated attacks include all hits but trigger active Rage only once', () => {
  const enemy = { combat_id: 1, hp: 7, block: 0, is_alive: true, intents: [{ damage: 20 }] };
  const card = { type: 'Attack', cost: 1, target_type: 'AllEnemies', attack_preview: { hits: 4 }, target_previews: [{ target_id: 1, damage: 2 }] };
  const combat = { player: { hp: 5, block: 0, energy: 3, powers: [{ id: 'RAGE_POWER', amount: 5 }] }, hand: [card], enemies: [enemy] };
  assert.equal(firstHitHpLoss(card, enemy).hp_loss, 2);
  assert.equal(attackHpLoss(card, enemy).hp_loss, 8);
  const estimate = combatForecast(combat, card);
  assert.equal(estimate.attack_hp_loss_by_target[0].hp_depleted, true);
  assert.equal(estimate.active_rage_block_gain, 5);
  assert.equal(estimate.fatal_if_end_turn, false);
  enemy.block = 3; enemy.powers = [{ id: 'BUFFER_POWER', amount: 1 }];
  card.target_previews[0].damage = 5;
  assert.equal(attackHpLoss(card, enemy).hp_loss, 15, 'Block and Buffer are consumed before later hits');
  enemy.block = 0; enemy.powers = [{ id: 'SLIPPERY_POWER', amount: 2 }];
  assert.equal(attackHpLoss(card, enemy).hp_loss, 12);
});

test('explicit X hit previews distinguish zero hits, energy-paid hits and a visible X modifier', () => {
  const enemy = { combat_id: 1, hp: 9, block: 0, is_alive: true, intents: [{ damage: 10 }] };
  const card = { type: 'Attack', cost: -1, target_type: 'AllEnemies', attack_preview: { hits: 0, energy_to_spend: 0 }, target_previews: [{ target_id: 1, damage: 5 }] };
  assert.equal(firstHitHpLoss(card, enemy), null);
  assert.equal(attackHpLoss(card, enemy).hp_loss, 0);
  card.attack_preview.hits = 2;
  assert.equal(attackHpLoss(card, enemy).hp_loss, 10, 'A current modifier may grant hits at zero energy');
  card.attack_preview = { hits: 3, energy_to_spend: 3 };
  assert.equal(attackHpLoss(card, enemy).hp_loss, 15);
});

test('the observed Obscura hand exposes its affordable 23-damage follower knockdown', () => {
  const target = { combat_id: 2, hp: 21, block: 0, is_alive: true, powers: [{ id: 'ILLUSION_POWER', amount: 1 }], intents: [{ damage: 16 }] };
  const card = (index, damage, hits = 1) => ({ index, type: 'Attack', cost: 1, can_play: true, target_type: 'AnyEnemy', attack_preview: { hits }, target_previews: [{ target_id: 2, damage }] });
  const hand = [card(0, 9), card(1, 2, 4), card(2, 6)];
  const combat = { player: { hp: 30, block: 0, energy: 3 }, hand, enemies: [target] };
  const forecast = combatForecast(combat, hand[0], target);
  assert.equal(forecast.followup_attacks.hp_damage, 14);
  assert.equal(forecast.followup_attacks.enough_to_deplete_target, true);
  assert.equal(target.powers[0].amount, 1, 'A predicted temporary knockdown never mutates the source state');
});

test('declared self HP loss can kill before an otherwise fully blocked enemy turn', () => {
  const target = { combat_id: 2, hp: 61, block: 0, is_alive: true, intents: [{ damage: 6 }] };
  const combat = { player: { hp: 1, energy: 1, block: 20 }, hand: [], enemies: [target] };
  const selfHarm = combatForecast(combat, { cost: 1, hp_loss: 2, target_previews: [{ target_id: 2, damage: 15 }] }, target);
  assert.equal(selfHarm.fatal_from_declared_hp_loss, true);
  assert.equal(selfHarm.fatal_if_end_turn, true);
  assert.equal(selfHarm.hp_remaining_after_declared_loss, -1);
  assert.equal(combatForecast(combat, { cost: 1, target_previews: [{ target_id: 2, damage: 6 }] }, target).hp_remaining_if_end_turn, 1, 'The recorded Strike alternative preserves life');
});

test('Toxic hand damage uses block, and playing or exhausting the affected cards removes it', () => {
  const toxicA = { id: 'TOXIC', type: 'Status', index: 0, cost: 1, damage: 5 };
  const toxicB = { ...toxicA, index: 1 };
  const combat = { player: { hp: 19, energy: 3, block: 10 }, hand: [toxicA, toxicB], enemies: [{ is_alive: true, hp: 50, block: 0, intents: [{ damage: 18 }] }] };
  assert.equal(combatForecast(combat).hp_remaining_if_end_turn, 1, 'Two Toxic cards explain the observed extra ten damage');
  assert.equal(combatForecast(combat, toxicA).hp_remaining_if_end_turn, 6);
  const exhausted = combatForecast(combat, { id: 'SECOND_WIND', type: 'Skill', index: 2, cost: 1, block: 5 });
  assert.equal(exhausted.end_turn_hand_damage, undefined);
  assert.equal(exhausted.hp_remaining_if_end_turn, 19);
  const finishingAttack = { cost: 1, index: 2, target_previews: [{ target_id: 1, damage: 50 }] };
  combat.enemies[0].combat_id = 1;
  assert.equal(combatForecast(combat, finishingAttack, combat.enemies[0]).end_turn_hand_damage, undefined, 'Ending combat avoids retained-hand turn-end effects, subject to the existing revival caveat');
});
