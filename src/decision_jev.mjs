import fs from 'fs';
import path from 'path';

export function getJevApiKey() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/TYPESAFE_API_KEY\s*=\s*([^\r\n]+)/);
    if (match) return match[1].trim();
  }
  return process.env.TYPESAFE_API_KEY || '';
}

/**
 * Make structured tactical decisions using TypeSafe Jev System One model.
 */
export async function makeDecisionWithJev(gameState) {
  const apiKey = getJevApiKey();
  if (!apiKey) {
    throw new Error('TYPESAFE_API_KEY not found in .env');
  }

  const url = 'https://api.typesafe.ai/v1/systemone';

  // 1. If not combat, handle menu/reward/map selections
  if (gameState.scene !== 'combat') {
    return handleNonCombatDecision(gameState, apiKey, url);
  }

  // 2. Combat phase decision
  const playableCards = (gameState.cards || []).filter(c => c.playable && c.cost <= gameState.player.energy);
  
  if (playableCards.length === 0 || gameState.player.energy <= 0) {
    return {
      action: 'end_turn',
      target: gameState.end_turn_btn?.screen_pos,
      reason: 'No playable cards or 0 energy remaining'
    };
  }

  // Format concise system state text for Jev
  const cardDescriptions = playableCards.map((c, i) => 
    `[${c.id || i}] ${c.name} (Cost: ${c.cost}, Type: ${c.type}, NeedsTarget: ${c.target_required})`
  ).join('\n');

  const enemyDescriptions = (gameState.enemies || []).map((e, i) =>
    `[${e.id || i}] ${e.name} (HP: ${e.hp}/${e.max_hp}, Block: ${e.block}, Intent: ${e.intent_type} ${e.intent_damage || 0})`
  ).join('\n');

  const stateContext = `Game: Slay the Spire 2 Combat
Player: HP ${gameState.player.hp}/${gameState.player.max_hp}, Block ${gameState.player.block}, Energy ${gameState.player.energy}/${gameState.player.max_energy}

Playable Cards in Hand:
${cardDescriptions}

Enemies:
${enemyDescriptions}`;

  // Build card choice criteria
  const cardCriteria = {};
  playableCards.forEach(c => {
    cardCriteria[c.id || c.name] = `Play ${c.name} (${c.type}, cost ${c.cost})`;
  });

  // Build enemy target criteria
  const targetCriteria = {};
  (gameState.enemies || []).forEach(e => {
    targetCriteria[e.id || e.name] = `Target ${e.name} (${e.hp} HP, intent: ${e.intent_type} ${e.intent_damage || ''})`;
  });

  const payload = {
    state: stateContext,
    model: 'jev-latest',
    questions: {
      should_end_turn: {
        type: 'noul',
        instructions: 'Should the player end their turn now without playing more cards?',
        criteria: {
          true: 'Player has no useful plays or wants to retain cards',
          false: 'Player should play a card'
        }
      },
      card_choice: {
        type: 'choice',
        instructions: 'Which card is best to play right now?',
        criteria: cardCriteria
      },
      threat_level: {
        type: 'score',
        instructions: 'How dangerous is the incoming enemy attack this turn?',
        criteria: [
          "Zero incoming damage",
          "Minor incoming damage (1-10) easily absorbed",
          "Moderate incoming damage (11-20)",
          "Heavy incoming damage (21-35) threatening survival",
          "Lethal or near lethal incoming attack"
        ]
      }
    }
  };

  // If there are targeted cards, add target choice question
  if (Object.keys(targetCriteria).length > 0) {
    payload.questions.target_choice = {
      type: 'choice',
      instructions: 'If a targeted card is played, which enemy is the priority target?',
      criteria: targetCriteria
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jev API error ${res.status}: ${err}`);
  }

  const result = await res.json();
  const answers = result.answers;

  // Decide action based on Jev's output
  if (answers.should_end_turn?.noul > 0.85) {
    return {
      action: 'end_turn',
      target: gameState.end_turn_btn?.screen_pos,
      reason: 'Jev decided to end turn'
    };
  }

  const chosenCardKey = answers.card_choice?.choice;
  const chosenCard = playableCards.find(c => (c.id || c.name) === chosenCardKey) || playableCards[0];

  let targetEnemy = null;
  if (chosenCard.target_required) {
    const chosenTargetKey = answers.target_choice?.choice;
    targetEnemy = (gameState.enemies || []).find(e => (e.id || e.name) === chosenTargetKey) || gameState.enemies[0];
  }

  return {
    action: 'play_card',
    card: chosenCard,
    target_enemy: targetEnemy,
    threat_level: answers.threat_level?.score,
    probabilities: answers.card_choice?.probabilities
  };
}

async function handleNonCombatDecision(gameState, apiKey, url) {
  const options = gameState.selectable_options || [];
  if (options.length === 0) {
    return { action: 'wait', reason: 'No selectable options visible' };
  }

  const criteria = {};
  options.forEach((opt, idx) => {
    criteria[`option_${idx}`] = `Choose ${opt.name}`;
  });

  const payload = {
    state: `Scene: ${gameState.scene}. Options available: ${options.map(o => o.name).join(', ')}`,
    model: 'jev-latest',
    questions: {
      choice: {
        type: 'choice',
        instructions: `Select the best option for the current ${gameState.scene} screen`,
        criteria: criteria
      }
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  const selectedKey = data.answers?.choice?.choice;
  const matchIndex = selectedKey ? parseInt(selectedKey.replace('option_', ''), 10) : 0;
  const chosen = options[matchIndex] || options[0];

  return {
    action: 'click',
    target: chosen.screen_pos,
    name: chosen.name
  };
}

if (process.argv[1]?.endsWith('decision_jev.mjs')) {
  console.log('Jev Decision Module ready. Using API Key:', getJevApiKey().slice(0, 10) + '...');
}


