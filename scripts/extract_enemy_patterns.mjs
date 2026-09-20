// Offline, version-pinned extraction from ILSpy's single-type C# output.
// No game is loaded and no RNG/state-machine code is executed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function balanced(text, start, open = '(', close = ')') {
  let depth = 0, quoted = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return text.slice(start + 1, i);
  }
  throw new Error('Unbalanced native source');
}
function argumentsOf(text) {
  let depth = 0, start = 0, quoted = false;
  const args = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return [...args, text.slice(start).trim()];
}
const numeric = value => /^-?\d+(?:\.\d+)?[fm]?$/.test(value || '') ? Number(value.replace(/[fm]$/, '')) : null;
const ruleId = type => type.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

function moveBody(source, method) {
  if (!/^\w+$/.test(method || '')) return '';
  const declaration = new RegExp(`(?:private|protected|public)\\s+(?:(?:override|async|virtual|static)\\s+)*Task(?:<[^>]+>)?\\s+${method}\\s*\\(`).exec(source);
  return declaration ? balanced(source, source.indexOf('{', declaration.index), '{', '}') : '';
}

// A rule reference is deliberately weaker than an effect. Creating, inspecting
// or conditionally applying a typed object makes its rule relevant, but says
// nothing about actual targets, quantity, timing, or successful application.
function referencedRules(body) {
  const cards = [...body.matchAll(/(?:CreateCard|ModelDb\.Card|AddToCombatAndPreview)<(\w+)>\s*\(/g)].map(m => ruleId(m[1]));
  const powers = [...body.matchAll(/(?:ModelDb\.Power|PowerCmd\.(?:Apply|Remove))<(\w+)>\s*\(/g)].map(m => ruleId(m[1].replace(/Power$/, '')));
  return [...new Set(cards)].map(id => ({ category: 'cards', id }))
    .concat([...new Set(powers)].map(id => ({ category: 'powers', id })));
}

// Resolve only a named move's direct card-generation calls. Amounts describe
// one invocation, not a simulated enemy turn; guards and hand overflow remain
// explicit. A symbolic amount is never turned into a guessed number.
function generatedCards(body) {
  return [...body.matchAll(/CardPileCmd\.AddToCombatAndPreview<(\w+)>\(/g)].map(match => {
    const args = argumentsOf(balanced(body, body.indexOf('(', match.index)));
    const pile = args[1]?.match(/^PileType\.(\w+)$/)?.[1];
    return { card_id: ruleId(match[1]),
      destination: pile ?? null, count: numeric(args[2]),
      ...(numeric(args[2]) === null ? { count_expression: args[2] ?? 'unknown' } : {}),
      recipients: args[0] === 'targets' ? 'move_targets' : 'unresolved',
      scope: 'Per native call if reached while this move resolves. Guards, repetitions, targets, modifiers, interruptions and destination overflow are not simulated. This does not add cards to the observed piles.' };
  });
}

// Verified v0.111.0 generic overloads: context, target(s), amount, applier,
// cardSource, optional silent. A call argument is not a simulated final stack.
function powerApplications(body) {
  return [...body.matchAll(/PowerCmd\.Apply<(\w+)>\s*\(/g)].map(match => {
    const args = argumentsOf(balanced(body, body.indexOf('(', match.index)));
    const target = args[1]?.replace(/\s+/g, '');
    const recipients = { 'base.Creature': 'self', targets: 'move_targets',
      'base.CombatState.GetTeammatesOf(base.Creature)': 'self_and_allies' }[target] ?? 'unresolved';
    return { power_id: ruleId(match[1].replace(/Power$/, '')), amount: numeric(args[2]),
      ...(numeric(args[2]) === null ? { amount_expression: args[2] ?? 'unknown' } : {}), recipients,
      ...(recipients === 'unresolved' ? { recipients_expression: args[1] ?? 'unknown' } : {}),
      scope: 'Native call arguments per invocation if reached. Conditions, loops, target availability, modifiers, prevention and duration are not simulated. Amount is not a resulting stack; referenced rules and live values take precedence over generic Wiki move summaries.' };
  });
}

export function extractPattern(source) {
  const offset = source.indexOf('GenerateMoveStateMachine()');
  if (offset < 0) return { states: [], gaps: ['Inherited or unavailable state-machine method.'] };
  const body = balanced(source, source.indexOf('{', offset), '{', '}');
  const variables = new Map(), states = [], gaps = [];
  // A chained assignment has ONE new state, not one state per alias.
  for (const match of body.matchAll(/new (MoveState|RandomBranchState|ConditionalBranchState)\("(\w+)"/g)) {
    const beginning = Math.max(body.lastIndexOf(';', match.index), body.lastIndexOf('\n', match.index));
    const left = body.slice(beginning + 1, match.index);
    const variable = left.match(/(?:^|\s)(\w+)\s*=/)?.[1];
    if (!variable) { gaps.push(`Unresolved declaration ${match[2]}`); continue; }
    const args = argumentsOf(balanced(body, body.indexOf('(', match.index)));
    const node = { id: match[2], type: { MoveState: 'move', RandomBranchState: 'random', ConditionalBranchState: 'conditional' }[match[1]] };
    if (node.type === 'move') {
      node.move_id = node.id.replace(/_MOVE$/, '');
      node.intents = [...args.slice(2).join(',').matchAll(/new (\w+)Intent\(/g)].map(m => m[1]);
      const move = moveBody(source, args[1]);
      const cards = generatedCards(move), references = referencedRules(move), powers = powerApplications(move);
      if (cards.length) node.generated_cards = cards;
      if (references.length) node.rule_references = references;
      if (powers.length) node.power_applications = powers;
      if (/MustPerformOnceBeforeTransitioning\s*=\s*true/.test(body.slice(match.index, body.indexOf(';', match.index)))) node.must_perform_once = true;
    } else node.branches = [];
    if (states.some(s => s.id === node.id)) gaps.push(`Duplicate state ${node.id}`);
    states.push(node); variables.set(variable, node);
    for (const link of left.matchAll(/(\w+)\.FollowUpState\s*=/g)) {
      if (variables.has(link[1])) variables.get(link[1]).next = node.id;
      else gaps.push(`Unresolved predecessor ${link[1]}`);
    }
  }
  for (const match of body.matchAll(/(\w+)\.FollowUpState\s*=\s*(\w+)\s*;/g)) {
    if (variables.has(match[1]) && variables.has(match[2])) variables.get(match[1]).next = variables.get(match[2]).id;
    else gaps.push(`Unresolved edge ${match[1]} -> ${match[2]}`);
  }
  for (const match of body.matchAll(/(\w+)\.(AddBranch|AddState)\(/g)) {
    const args = argumentsOf(balanced(body, body.indexOf('(', match.index)));
    const node = variables.get(match[1]), target = variables.get(args[0]);
    if (!node?.branches || !target) { gaps.push(`Unresolved branch ${match[1]}`); continue; }
    const branch = { next: target.id };
    if (match[2] === 'AddState') branch.condition = args[1]?.replace(/^\(\)\s*=>\s*/, '') ?? 'unknown';
    else {
      const hasCooldown = args.length === 4 || args[2]?.startsWith('MoveRepeatType.');
      const repeat = args[hasCooldown ? 2 : 1];
      if (hasCooldown) branch.cooldown = numeric(args[1]);
      branch.repeat = repeat?.startsWith('MoveRepeatType.') ? repeat.split('.').at(-1) : 'CanRepeatXTimes';
      if (branch.repeat === 'CanRepeatXTimes') branch.max_consecutive = numeric(repeat);
      // Optional weight defaults to 1; the second integer is a repeat cap.
      const weight = (args[hasCooldown ? 3 : 2] || '1').replace(/^\(\)\s*=>\s*/, '');
      branch.base_weight = numeric(weight);
      if (branch.base_weight === null) branch.weight_condition = weight;
      if (args.length > 4) gaps.push(`Unsupported branch arguments ${node.id}`);
    }
    node.branches.push(branch);
  }
  for (const node of states) if (node.branches?.length === 0) gaps.push(`Empty ${node.type} branches: ${node.id}`);
  const initials = [...body.matchAll(/return new MonsterMoveStateMachine\(/g)].flatMap(m => {
    const args = argumentsOf(balanced(body, body.indexOf('(', m.index)));
    return variables.has(args[1]) ? [variables.get(args[1]).id] : [];
  });
  const initial = initials.length === 1 && !/\bif\s*\(/.test(body) ? initials[0] : null;
  if (initial === null) gaps.push('Initial state depends on unextracted conditions; not predicted.');
  if (/\bif\s*\(/.test(body)) gaps.push('Conditional graph construction: listed states/edges are possible; registration guards are not evaluated.');
  // Such hooks can override the normal cycle. Expose this limitation even
  // when the corresponding power's public rule is present elsewhere.
  const interrupts = [...new Set([...source.matchAll(/(?:SetMoveImmediate|SetMove|ForceNextMove|NextMove|Stun)\s*\(/g)].map(m => m[0].replace(/\s*\($/, '')))];
  return { initial_state: initial, states, external_transitions: interrupts,
    gaps: [...new Set(gaps)], scope: 'Static normal transitions. Conditions and repeat limits are constraints, not sampled outcomes. Damage, stun, phase changes, deaths, summons and powers can interrupt this graph; their live rules take precedence.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, assembly, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/extract_enemy_patterns.mjs <single-type-source-dir> <sts2.dll> <output.json>');
  const monsters = JSON.parse(fs.readFileSync(new URL('../data/spire-codex/v0.111.0/monsters.json', import.meta.url)));
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.cs'));
  const normalize = name => name.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const entries = {};
  for (const monster of monsters) {
    const file = files.find(file => normalize(file.slice(0, -3)) === normalize(monster.id));
    let source = file && fs.readFileSync(path.join(directory, file), 'utf8'), inheritedFrom = null;
    if (source && !source.includes('GenerateMoveStateMachine()')) {
      const parent = source.match(/class \w+\s*:\s*(\w+)/)?.[1];
      if (parent && files.includes(parent + '.cs')) { inheritedFrom = parent; source = fs.readFileSync(path.join(directory, parent + '.cs'), 'utf8'); }
    }
    entries[monster.id] = source ? { source_type: file.slice(0, -3), ...(inheritedFrom ? { inherited_from: inheritedFrom } : {}), source_sha256: createHash('sha256').update(source).digest('hex'), ...extractPattern(source) }
      : { states: [], gaps: ['No matching native type; public Codex reference only.'] };
  }
  const data = { schema_version: 1, game_version: 'v0.111.0', extracted_at: new Date().toISOString(),
    source: 'Local installed sts2.dll; static inspection only. No native code or live RNG is invoked.',
    assembly_sha256: createHash('sha256').update(fs.readFileSync(assembly)).digest('hex'),
    semantics: { base_weight: 'Relative random weight before repeat restrictions, cooldowns and conditions; not an unconditional probability.', max_consecutive: 'Maximum consecutive selections, not a branch weight.', cooldown: 'Disallow if this move occurred among the last N moves.', condition: 'Conditional branches take the first true predicate. Predicates are unevaluated; never assume private flags or missing history.', rule_references: 'Rule types directly referenced by the named move method. References are not confirmed effects: conditions, quantities, recipients, destinations, helper methods and timing are not inferred. They never add powers or cards to the observed state.' }, entries };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify({ monsters: monsters.length, with_states: Object.values(entries).filter(e => e.states.length).length,
    gaps: Object.entries(entries).filter(([, e]) => e.gaps.length).map(([id, e]) => ({ id, gaps: e.gaps })) }, null, 2));
}
