import fs from 'node:fs';
import path from 'node:path';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const NON_COMBAT_SCENES = new Set(['reward', 'map', 'rest', 'event', 'main_menu', 'shop', 'treasure', 'card_select', 'character_select', 'dialog', 'settings']);

export function getJevApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return '';
  const match = fs.readFileSync(envPath, 'utf8').match(/^\s*TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m);
  return match ? match[1].replace(/^(['"])(.*)\1$/, '$2') : '';
}

function hasPosition(position) {
  return Number.isFinite(position?.x) && Number.isFinite(position?.y);
}

function wait(reason) {
  return { action: 'wait', reason };
}

function combatCandidates(state) {
  const candidates = new Map();
  const energy = state.player?.energy;
  if (!Number.isFinite(energy) || energy < 0) return candidates;

  const enemies = (state.enemies || []).map((enemy, index) => ({ enemy, index }))
    .filter(({ enemy }) => hasPosition(enemy.screen_pos) && enemy.targetable !== false && enemy.hp !== 0);
  for (const [cardIndex, card] of (state.cards || []).entries()) {
    const affordable = (Number.isFinite(card.cost) && card.cost >= 0 && card.cost <= energy) || card.cost === 'X';
    if (card.playable !== true || !affordable || !hasPosition(card.screen_pos)) continue;
    if (card.target_required === true) {
      for (const { enemy, index: enemyIndex } of enemies) {
        candidates.set(`card_${cardIndex}_enemy_${enemyIndex}`, {
          action: 'play_card', card, target_enemy: enemy
        });
      }
    } else if (card.target_required === false && state.play_area?.visible === true && hasPosition(state.play_area.screen_pos)) {
      candidates.set(`card_${cardIndex}`, { action: 'play_card', card, target_enemy: null });
    }
  }

  // Observe again when a targeted playable card has no visible target.
  if (candidates.size === 0 && enemies.length === 0 && (state.cards || []).some(card => card.playable === true && card.target_required === true)) {
    return candidates;
  }
  if (state.end_turn_btn?.visible === true && state.end_turn_btn.enabled !== false && hasPosition(state.end_turn_btn.screen_pos)) {
    candidates.set('end_turn', { action: 'end_turn', target: state.end_turn_btn.screen_pos });
  }
  return candidates;
}

function candidateDescription(candidate) {
  if (candidate.action === 'end_turn') return 'End the current player turn.';
  if (candidate.action === 'click') return `Select the visible option: ${candidate.name}${candidate.description ? `; ${candidate.description}` : ''}${candidate.selected === true ? '; this option is visibly ALREADY SELECTED' : candidate.selected === false ? '; this option is visibly not selected' : ''}`;
  const card = candidate.card;
  const effect = card.description || card.effects || 'Effect not visible';
  const target = candidate.target_enemy;
  return `Play this specific hand card: ${card.name}; cost ${card.cost}; effect ${typeof effect === 'string' ? effect : JSON.stringify(effect)}.`
    + (target ? ` Target this specific enemy: ${target.name}; HP ${target.hp}; block ${target.block}.` : ' This card has no enemy target.');
}

/** Select one complete, executable action. Probability is logged, not used as a gate. */
export async function makeDecisionWithJev(gameState, options = {}) {
  if (!gameState || gameState.scene === 'unknown') return wait('Scene is unknown');

  let candidates;
  if (gameState.scene === 'combat') {
    if (gameState.player_turn !== true) return wait('Player turn is not confirmed');
    candidates = combatCandidates(gameState);
  } else if (NON_COMBAT_SCENES.has(gameState.scene)) {
    candidates = new Map();
    for (const [index, option] of (gameState.selectable_options || []).entries()) {
      if (option.enabled === false || option.visible === false || !hasPosition(option.screen_pos)) continue;
      candidates.set(`option_${index}`, { action: 'click', target: option.screen_pos, name: option.name, description: option.description, selected: option.selected });
    }
  } else {
    return wait('Scene is not supported');
  }
  if (candidates.size === 0) return wait('No complete visible action is available');
  if (candidates.size > 255) throw new Error('Jev Choice supports at most 255 action candidates');

  const apiKey = options.apiKey ?? getJevApiKey();
  if (!apiKey) throw new Error('TYPESAFE_API_KEY not found');
  const payload = {
    model: options.model || 'jev-latest',
    // Preserve visible descriptions/effects, resources and scene-specific context.
    state: gameState,
    questions: {
      next_action: {
        type: 'choice',
        instructions: 'Choose one next action toward winning the first combat in Slay the Spire 2. Each option is a complete action; choose a specific card and its specific target together. In combat, use visible effects, enemy HP and incoming damage to finish enemies while preserving HP. Spend energy on useful attacks or block; end turn when no useful affordable card remains. Outside combat, continue an existing run if available; otherwise start a single-player standard run as Ironclad, confirm the character and choose a reachable normal combat map node. If Ironclad is already selected (selected=true or his details are displayed), choose the enabled confirm/start check mark rather than selecting his portrait again. At a required card selection choose a suitable card then confirm if required. Read recent_actions: if the same choice was already attempted and no structured change was observed, prefer a different forward-progress control instead of repeating it. Do not choose quit, abandon, settings or back when a forward-progress choice is available. Use the observed card descriptions and screen state; do not assume unseen effects. Candidate card_N and enemy_N indices refer to the state cards and enemies arrays.',
        criteria: Object.fromEntries([...candidates].map(([id, candidate]) => [id, candidateDescription(candidate)]))
      }
    }
  };
  const started = performance.now();
  const response = await (options.fetchImpl || globalThis.fetch)(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000)
  });
  if (!response.ok) {
    throw new Error(`Jev API error ${response.status}`);
  }
  const result = await response.json();
  const answer = result.answers?.next_action;
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !candidates.has(answer.choice)) {
    throw new Error('Jev returned an invalid next_action choice');
  }
  return {
    ...candidates.get(answer.choice),
    candidate_id: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    model: result.model,
    usage: result.usage,
    durationMs: Math.round(performance.now() - started)
  };
}

if (process.argv[1]?.endsWith('decision_jev.mjs')) {
  console.log('Jev Decision Module ready. API key configured:', Boolean(getJevApiKey()));
}
