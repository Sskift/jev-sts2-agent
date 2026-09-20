import { attackHpLoss, previewHitCount, intentDamage } from './combat_arithmetic.mjs';

// These adapters follow verified native v0.111.0 OnPlay ordering. Amounts
// come from resolved live text, never from a base/upgrade Wiki guess.
const applications = { BASH: ['Vulnerable'], UPPERCUT: ['Weak', 'Vulnerable'], THUNDERCLAP: ['Vulnerable'], SHOCKWAVE: ['Weak', 'Vulnerable'] };
function applicationAmount(card, kind) {
  const rule = card.id === 'THUNDERCLAP' ? /^Deal [\d.]+ damage and apply (\d+) Vulnerable to ALL enemies\.(?:\s|$)/i
    : card.id === 'SHOCKWAVE' ? /^Apply (\d+) Weak and Vulnerable to ALL enemies\.(?:\s|$)/i
      : new RegExp(`(?:^|\\.\\s*)Apply (\\d+) ${kind}\\.`);
  return Number(card.description.match(rule)?.[1]);
}
const power = (entity, id) => (entity.powers || []).find(p => p.id === id && p.amount > 0);
const caps = entity => ['INTANGIBLE_POWER', 'SLIPPERY_POWER', 'BUFFER_POWER'].some(id => power(entity, id));
const customMultiplier = (combat, enemy, kind) => power(enemy, 'DEBILITATE_POWER')
  || (kind === 'Vulnerable' ? power(combat.player, 'CRUELTY_POWER') : false)
  || combat.player.relics?.some(r => r.id === (kind === 'Vulnerable' ? 'PAPER_PHROG' : 'PAPER_KRANE'));
const blockedRule = enemy => (enemy.powers || []).some(p => p.id !== 'ARTIFACT_POWER'
  && /(?:prevent|immune|cannot)[^.]*\b(?:debuff|weak|vulnerable)/i.test(p.description || ''));

// Native previews discard a fractional remainder. Multiplying the integer
// alone could miss a point of damage. Preserve both possible rounded bounds.
function scaledPreview(value, numerator, denominator, bound) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return bound === 'min' ? Math.floor(value * numerator / denominator)
    : Math.ceil((value + 1) * numerator / denominator) - 1;
}

/** Separate conditional dependency analysis; never writes powers into a real
 * observation. It covers new Weak/Vulnerable from the declared adapters, not
 * arbitrary card effects, future enemy choices, or a complete combat engine. */
export function projectDebuffDependencies(state, steps, orderedEntries = null) {
  if (!steps.some(step => applications[state.combat.hand.find(card => card.details?.instance_id === step.card_instance_id)?.id])) return null;
  const observed = state.combat;
  const affected = new Set(), transitions = [], damage = [];
  const invalid = new Set(), invalidIncoming = new Set();
  const branches = ['min', 'max'].map(bound => ({ bound, enemies: structuredClone(observed.enemies) }));
  for (const [sequence, step] of steps.entries()) {
    if (step.kind === 'end_turn') break;
    let card = orderedEntries ? orderedEntries.find(e => e.sequence === sequence)?.card : observed.hand.find(c => c.details?.instance_id === step.card_instance_id);
    if (!card) continue;
    // A payment-stage count from the current hand cannot be reused after a
    // hypothetical prefix that may spend/gain energy or alter X payment.
    if (!orderedEntries && card.cost < 0 && sequence > 0) card = { ...card, attack_preview: undefined };
    const ids = card.target_type === 'AllEnemies' ? observed.enemies.map(e => e.combat_id) : [step.target];
    for (const id of ids) {
      const original = observed.enemies.find(e => e.combat_id === id);
      if (!original) continue;
      // Native target previews enumerate HittableEnemies for area effects,
      // including non-damaging skills. Absence is not permission to invent a
      // recipient (e.g. a creature temporarily outside that set).
      if (card.target_type === 'AllEnemies' && !card.target_previews?.some(p => p.target_id === id)) continue;
      const perHit = {};
      let boosted = false;
      for (const { bound, enemies } of branches) {
        const enemy = enemies.find(e => e.combat_id === id);
        if (!enemy.is_alive || enemy.hp <= 0) continue;
        const newlyVulnerable = !power(original, 'VULNERABLE_POWER') && power(enemy, 'VULNERABLE_POWER');
        let preview = card.target_previews?.find(p => p.target_id === id)?.damage;
        if (card.type === 'Attack') {
          if (newlyVulnerable && card.id !== 'OMNISLICE') {
            boosted = true; affected.add(id);
            preview = caps(original) || customMultiplier(observed, enemy, 'Vulnerable') ? null : scaledPreview(preview, 3, 2, bound);
          }
          if ((power(enemy, 'VULNERABLE_POWER')?.amount || 0) !== (power(original, 'VULNERABLE_POWER')?.amount || 0)
            && /\bfor (?:each|every)\b[^.]*\bVulnerable\b/i.test(card.description)) {
            affected.add(id); preview = null; // Both the base damage and multiplier changed; old previews cannot establish a point/range.
          }
          const hits = previewHitCount(card);
          if (preview === null || preview === undefined || hits === null) invalid.add(id);
          else {
            const projectedCard = { ...card, target_previews: [{ target_id: id, damage: preview }] };
            const hit = attackHpLoss(projectedCard, enemy);
            if (hit) { enemy.hp = Math.max(0, enemy.hp - hit.hp_loss); enemy.block = hit.block_after; enemy.powers = hit.powers_after; enemy.is_alive = enemy.hp > 0; }
            else invalid.add(id);
          }
          perHit[bound] = preview ?? null;
        }
        for (const kind of applications[card.id] || []) {
          const amount = applicationAmount(card, kind);
          const powerId = kind === 'Weak' ? 'WEAK_POWER' : 'VULNERABLE_POWER';
          let outcome = 'applied';
          if (!Number.isSafeInteger(amount) || amount <= 0 || blockedRule(enemy)) {
            outcome = 'unresolved'; affected.add(id); invalid.add(id); invalidIncoming.add(id);
          } else if (!enemy.is_alive) outcome = 'target_depleted';
          else if (power(enemy, 'ARTIFACT_POWER')) { power(enemy, 'ARTIFACT_POWER').amount--; outcome = 'absorbed_by_artifact'; }
          else {
            const existing = power(enemy, powerId);
            if (existing) existing.amount += amount;
            else enemy.powers.push({ id: powerId, amount });
            affected.add(id);
          }
          if (bound === 'min') transitions.push({ sequence, card_id: card.id, target_id: id, power_id: powerId, amount: Number.isFinite(amount) ? amount : null,
            timing: card.type === 'Attack' ? 'after_card_damage' : 'during_card_effect', outcome,
            condition: 'Minimum-damage branch; a target killed by greater possible preceding damage receives no later application.' });
        }
      }
      if (card.type === 'Attack') damage.push({ sequence, card_id: card.id, target_id: id,
        per_hit: { min: perHit.min ?? null, max: perHit.max ?? null }, preview_hits: previewHitCount(card), includes_new_vulnerable: Boolean(boosted) });
    }
  }
  if (!transitions.length) return null;
  const enemies = observed.enemies.map(original => {
    const variants = branches.map(b => b.enemies.find(e => e.combat_id === original.combat_id));
    const newlyWeak = !power(original, 'WEAK_POWER') && variants.some(e => power(e, 'WEAK_POWER'));
    if (newlyWeak && (caps(observed.player) || customMultiplier(observed, original, 'Weak'))) invalidIncoming.add(original.combat_id);
    const hp = invalid.has(original.combat_id) ? { min: null, max: null }
      : { min: Math.min(...variants.map(e => e.hp)), max: Math.max(...variants.map(e => e.hp)) };
    const attacks = ['min', 'max'].map(bound => {
      if (hp.max === null || invalidIncoming.has(original.combat_id)) return null;
      if ((bound === 'min' ? hp.min : hp.max) === 0) return 0;
      if (!newlyWeak) return intentDamage(original);
      return original.intents.reduce((sum, intent) => sum + (Number.isFinite(intent.damage)
        ? scaledPreview(intent.damage, 3, 4, bound) * (intent.hits || 1) : 0), 0);
    });
    return { combat_id: original.combat_id, hp_remaining: hp,
      depleted_if_all_declared_hits_resolve: hp.max === null ? null : hp.max === 0,
      current_attack_after_debuffs: attacks.includes(null) ? { min: null, max: null } : { min: Math.min(...attacks), max: Math.max(...attacks) } };
  });
  return { is_observed_effect: false, adapters: [...new Set(transitions.map(t => t.card_id))], affected_target_ids: [...affected], transitions, ordered_damage: damage, enemies,
    scope: 'Conditional ordered damage and current-intent bounds for verified native v0.111.0 debuff applications followed by known target previews. Attack-source debuffs apply after damage; Artifact consumes applications in order. Area recipients come from native target previews. Existing Weak/Vulnerable are not multiplied twice. Integer previews hide fractions, so new 1.5x/0.75x modifiers yield ranges. Known damage caps, custom multipliers or unreadable applications stay unknown. Assumes other preview inputs/hooks remain unchanged and every declared hit resolves; no upgrades, potions, changing card values, automatic card replays, unknown repetitions, reactions, random targets or future enemy moves are simulated. These ranges replace stale point estimates for affected enemies, not actual observations.' };
}
