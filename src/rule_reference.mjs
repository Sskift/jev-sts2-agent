import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeRuleId as normalize, visitRuleEntities } from './rule_entities.mjs';
import { enemyPattern, enemyPatternSource } from './enemy_patterns.mjs';

const directory = new URL('../data/spire-codex/v0.111.0/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', directory), 'utf8'));
const categories = Object.keys(manifest.files);
const records = {}, names = new Map();
for (const category of categories) {
  const body = fs.readFileSync(new URL(category + '.json', directory));
  if (createHash('sha256').update(body).digest('hex') !== manifest.files[category].sha256) throw new Error(`Rule snapshot checksum mismatch: ${category}`);
  records[category] = new Map();
  for (const row of JSON.parse(body)) {
    records[category].set(normalize(row.id), row);
    // Duplicate names (e.g. five starter Strikes) are deliberately not guessed.
    const key = normalize(row.name), matches = names.get(key) || [];
    matches.push([category, row.id]); names.set(key, matches);
  }
}
const mechanicTerms = [...names.values()].filter(matches => matches.length === 1 && ['powers', 'keywords', 'afflictions', 'enchantments'].includes(matches[0][0])).map(([match]) => {
  const term = records[match[0]].get(normalize(match[1])).name;
  return { match, pattern: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') };
});

// Share the verified snapshot index; callers must not use example Wiki numbers
// as current amounts or mutate the stored record.
export const lookupRule = (category, id) => records[category]?.get(normalize(id)) ?? null;

const clean = value => typeof value === 'string' ? value.replace(/\[\/?(?:gold|blue|red|green|orange|purple|grey|gray|pink|sine|jitter|b|i)\]/g, '')
  : Array.isArray(value) ? value.map(clean)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, clean(item)])) : value;
const pick = (row, keys) => clean(Object.fromEntries(keys.filter(key => row[key] !== null && row[key] !== undefined).map(key => [key, row[key]])));

function project(category, row) {
  const identity = { id: row.id, name: row.name };
  if (category === 'cards') return { ...identity,
    base_rules: clean(row.description), ...(row.upgrade_description ? { upgraded_rules: clean(row.upgrade_description) } : {}),
    ...pick(row, ['type', 'target', 'keywords', 'tags', 'spawns_cards']),
    base_energy_cost: row.is_x_cost ? 'X' : row.cost,
    ...(row.star_cost !== null ? { base_star_cost: row.is_x_star_cost ? 'X' : row.star_cost } : {}),
    ...pick(row, ['vars', 'upgrade']) };
  if (category === 'events') return { ...identity, ...pick(row, ['type', 'preconditions', 'description', 'options', 'pages']),
    coverage: row.pages?.length ? 'Public possible pages, not the observed current page or guaranteed future outcome.' : 'Detailed pages unavailable in this reference; use live options.' };
  if (category === 'monsters') return { ...identity, ...pick(row, ['type', 'moves', 'innate_powers']),
    attack_pattern: enemyPattern(row.id) || row.attack_pattern,
    scope: 'Public base move repertoire/pattern, not the current hidden move or future random selection. Actual intent/damage/powers come from combat.enemies.' };
  if (category === 'powers') return { ...identity, ...pick(row, ['type', 'stack_type', 'allow_negative']),
    rule_template: clean(row.description_raw || row.description),
    amounts: 'Template/example amounts are not current stacks; use live power amounts and resolved descriptions.' };
  return pick(row, ['id', 'name', 'description', 'description_raw', 'extra_card_text', 'is_stackable', 'applicable_to', 'card_type', 'monsters']);
}

/** Select a transitive set of public rules. Never alters state, candidates, or numeric previews. */
export function buildRuleReference(state) {
  if (!state.decision_context?.run_id) return null;
  const selected = new Map(), missing = new Set(), queue = [], links = new Map();
  let relationSource = null;
  function add(category, id) {
    if (!id || !records[category]) return;
    const row = records[category].get(normalize(category === 'powers' ? String(id).replace(/Power$/, '') : id));
    if (!row) { missing.add(`${category}/${id}`); return; }
    const key = `${category}/${row.id}`;
    if (relationSource && relationSource !== key) {
      if (!links.has(relationSource)) links.set(relationSource, new Set());
      links.get(relationSource).add(key);
    }
    if (!selected.has(key)) { selected.set(key, [category, row]); queue.push([category, row]); }
  }
  function named(value, allowed) {
    const matches = (names.get(normalize(value)) || []).filter(([category]) => allowed.includes(category));
    if (matches.length === 1) add(...matches[0]);
  }
  visitRuleEntities(state, ({ category, id, name }) => id ? add(category, id) : named(name, [category]));
  for (let index = 0; index < queue.length; index++) {
    const [category, row] = queue[index];
    relationSource = `${category}/${row.id}`;
    for (const id of row.spawns_cards || []) add('cards', id);
    for (const keyword of row.keywords_key || row.keywords || []) add('keywords', keyword);
    for (const power of row.powers_applied || []) add('powers', power.power_key || power.power);
    for (const power of row.innate_powers || []) add('powers', power.power_id);
    for (const move of row.moves || []) for (const power of move.powers || []) add('powers', power.power_id);
    if (category === 'monsters') for (const move of enemyPattern(row.id)?.states || []) {
      for (const generated of move.generated_cards || []) add('cards', generated.card_id);
      for (const reference of move.rule_references || []) add(reference.category, reference.id);
    }
    if (category === 'encounters') for (const monster of row.monsters || []) add('monsters', monster.id);
    for (const variable of Object.keys(row.vars || {})) if (variable !== 'Power' && variable.endsWith('Power')) add('powers', variable);
    // Exact tagged terms link mechanics and named generated items. Unknown or
    // ambiguous labels stay unlinked; never expand random pools to every card.
    const relevant = project(category, row);
    const taggedText = JSON.stringify(category === 'events' ? { description: row.description, options: row.options, pages: row.pages } : { description: row.description, upgraded: row.upgrade_description, extra: row.extra_card_text, moves: row.moves });
    for (const match of taggedText.matchAll(/\[gold\]([^\[\]]+)\[\/gold\]/g)) named(match[1], ['powers', 'keywords', 'enchantments', 'afflictions', 'orbs', 'cards', 'relics', 'potions']);
    // Some named card powers (Rage, Barricade, etc.) have no powers_applied field.
    if (category === 'cards' && records.powers.has(normalize(row.id))) add('powers', row.id);
    // Native descriptions have their formatting tags removed; match full named
    // mechanics, not fragments ("Weak" must not match "Weakness").
    const ruleText = JSON.stringify(relevant);
    for (const { match, pattern } of mechanicTerms) if (pattern.test(ruleText)) add(...match);
  }
  return { source: manifest.source_url, game_version: manifest.game_version, fetched_at: manifest.fetched_at,
    enemy_pattern_source: enemyPatternSource,
    scope: 'Static public reference for current entities and related rules. Live mod state, resolved card text, costs, upgrades, counters, intent, previews and legal_actions take precedence. References do not reveal this run\'s hidden rolls or add legal actions. Null/missing values are unknown. Wiki extraction may be incomplete; parsed draw/damage summaries are not used for calculations.',
    entries: Object.fromEntries(categories.map(category => [category, [...selected.values()].filter(([type]) => type === category).map(([, row]) => {
      const related = [...(links.get(`${category}/${row.id}`) || [])];
      const nativeTip = state.decision_context.glossary?.find(tip => normalize(tip.title) === normalize(row.name));
      return { ...project(category, row), ...(nativeTip ? { native_tooltip: nativeTip.description } : {}), ...(related.length ? { related_rules: related } : {}) };
    })]).filter(([, rows]) => rows.length)),
    ...(missing.size ? { missing: [...missing].sort() } : {}) };
}
