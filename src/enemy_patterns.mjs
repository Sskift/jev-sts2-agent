import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(new URL('../data/strategy/v0.111.0/enemy-patterns.json', import.meta.url)));
export const enemyPattern = id => data.entries[String(id).toUpperCase()] ?? null;
export const enemyPatternSource = { game_version: data.game_version, assembly_sha256: data.assembly_sha256,
  source: data.source, semantics: data.semantics };

// Match only public intent shape. Internal move IDs and RNG are never inputs.
// Similar attacks can stay ambiguous; native damage includes modifiers, so
// equality with a Wiki base damage is NOT an identification rule.
const intentKind = kind => /Attack/.test(kind) ? 'Attack' : kind.replace(/Intent$/, '').replace(/^StatusCard$/, 'Status');
function compatible(node, enemy, repertoire) {
  const actual = (enemy.intents || []).map(i => intentKind(i.type)).sort();
  const expected = (node.intents || []).map(intentKind).sort();
  if (!actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  const move = repertoire?.find(move => move.id === node.move_id);
  const attack = enemy.intents.find(i => intentKind(i.type) === 'Attack');
  if (attack && move?.damage) return (attack.hits || 1) === (move.damage.hit_count || 1);
  return true;
}

export function enemyOutlook(enemy, repertoire = []) {
  const pattern = enemyPattern(enemy.id);
  if (!pattern?.states.length) return { combat_id: enemy.combat_id, matching_moves: [], unknown: 'No verified native pattern available.' };
  const byId = new Map(pattern.states.map(s => [s.id, s]));
  const matches = pattern.states.filter(s => s.type === 'move' && compatible(s, enemy, repertoire));
  function next(id, depth, path = new Set()) {
    const node = byId.get(id);
    if (!node || path.has(id)) return { unknown: 'Missing or cyclic branch transition.' };
    if (node.type === 'move') return { move_id: node.move_id, ...(node.generated_cards ? { generated_cards: node.generated_cards } : {}),
      ...(node.rule_references ? { rule_references: node.rule_references } : {}),
      ...(depth > 1 && node.next ? { then: next(node.next, depth - 1) } : {}) };
    return { branch: node.type, candidates: node.branches.map(b => ({ ...b, outcome: next(b.next, depth, new Set([...path, id])) })),
      resolution: 'Unknown. Conditions, cooldowns and prior-move eligibility are not evaluated; no RNG result or normalized probability is asserted.' };
  }
  return { combat_id: enemy.combat_id,
    identification: matches.length === 1 ? 'One static move matches the visible intent shape.' : 'Visible intent is ambiguous or unmatched; all compatible normal transitions remain possible.',
    matching_moves: matches.map(node => ({ current_move: node.move_id,
      ...(node.generated_cards ? { generated_cards_if_current_move_resolves: node.generated_cards } : {}),
      ...(node.rule_references ? { current_move_rule_references: node.rule_references } : {}),
      after_current_intent: node.next ? next(node.next, 2) : { unknown: 'No ordinary follow-up extracted.' } })),
    external_transitions: pattern.external_transitions, coverage_gaps: pattern.gaps,
    scope: 'Conditional on this identification, current intent resolving, survival and no interrupt. Current intent has not executed. Stuns, phase/death powers and other live rules override normal transitions; future damage is not the current intent damage.' };
}
