import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { analyzeScreenshot } from './vision_opus.mjs';
import { makeDecisionWithJev } from './decision_jev.mjs';

const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runComputerUse(cmd) {
  const result = execSync(`python src/computer_use.py ${cmd}`, { encoding: 'utf8' });
  return result.trim();
}

/**
 * Single cycle of the autonomous agent loop.
 */
export async function runLoopCycle(options = { mockState: null }) {
  console.log('\n==================== [Agent Loop Tick] ====================');

  let gameState;

  if (options.mockState) {
    console.log('[Perception] Using mock gameState for testing/simulation...');
    gameState = options.mockState;
  } else {
    // 1. Capture screen
    const screenPath = path.join(TEMP_DIR, 'screen.png');
    console.log('[Perception] Capturing screen via Computer Use...');
    runComputerUse(`capture "${screenPath}"`);

    // 2. Vision perception via Claude Opus 5
    console.log('[Perception] Analyzing screenshot with Claude Opus 5...');
    const startTime = Date.now();
    gameState = await analyzeScreenshot(screenPath);
    console.log(`[Perception] Screen parsed in ${Date.now() - startTime}ms. Scene: ${gameState.scene}`);
  }

  // 3. Decision making via TypeSafe Jev (System One)
  console.log('[Decision] Asking TypeSafe Jev for tactical action...');
  const jevStartTime = Date.now();
  const decision = await makeDecisionWithJev(gameState);
  console.log(`[Decision] Jev responded in ${Date.now() - jevStartTime}ms:`, JSON.stringify(decision));

  // 4. Action execution via Computer Use
  console.log('[Action] Executing action with Computer Use...');
  if (decision.action === 'play_card') {
    const card = decision.card;
    const startX = card.screen_pos.x;
    const startY = card.screen_pos.y;

    if (card.target_required && decision.target_enemy) {
      const endX = decision.target_enemy.screen_pos.x;
      const endY = decision.target_enemy.screen_pos.y;
      console.log(`[Action] Dragging card "${card.name}" from (${startX}, ${startY}) to enemy "${decision.target_enemy.name}" at (${endX}, ${endY})`);
      runComputerUse(`drag ${startX} ${startY} ${endX} ${endY}`);
    } else {
      // Non-targeted card (skill, buff, or AOE): drag to center battlefield
      const endX = Math.round(startX);
      const endY = Math.max(100, startY - 500);
      console.log(`[Action] Dragging card "${card.name}" from (${startX}, ${startY}) to battlefield at (${endX}, ${endY})`);
      runComputerUse(`drag ${startX} ${startY} ${endX} ${endY}`);
    }
  } else if (decision.action === 'end_turn') {
    const pos = decision.target || { x: 3400, y: 1500 };
    console.log(`[Action] Clicking End Turn button at (${pos.x}, ${pos.y})`);
    runComputerUse(`click ${pos.x} ${pos.y}`);
  } else if (decision.action === 'click') {
    const pos = decision.target;
    console.log(`[Action] Clicking option "${decision.name}" at (${pos.x}, ${pos.y})`);
    runComputerUse(`click ${pos.x} ${pos.y}`);
  } else {
    console.log('[Action] No execution needed for current action:', decision.action);
  }

  console.log('==================== [Tick Completed] ====================\n');
}

/**
 * Main infinite agent loop.
 */
export async function startLoop(intervalMs = 2000) {
  console.log('Starting Slay the Spire 2 Autonomous Agent Loop...');
  console.log('Perception: Claude Opus 5 (Vision)');
  console.log('Decision: TypeSafe Jev (System One)');
  console.log('Execution: Native OS Computer Use');

  while (true) {
    try {
      await runLoopCycle();
    } catch (err) {
      console.error('[Error in loop tick]:', err.message);
    }
    await sleep(intervalMs);
  }
}

if (process.argv[1]?.endsWith('agent_loop.mjs')) {
  // If run with --sim, run a single mock cycle to verify orchestration
  if (process.argv.includes('--sim')) {
    const mockState = {
      scene: 'combat',
      player: { hp: 50, max_hp: 80, block: 5, energy: 2, max_energy: 3 },
      cards: [
        { id: 'strike', name: 'Strike', cost: 1, type: 'attack', target_required: true, playable: true, screen_pos: { x: 1800, y: 2000 } },
        { id: 'defend', name: 'Defend', cost: 1, type: 'skill', target_required: false, playable: true, screen_pos: { x: 2000, y: 2000 } }
      ],
      enemies: [
        { id: 'jaw_worm', name: 'Jaw Worm', hp: 32, max_hp: 40, block: 0, intent_type: 'attack', intent_damage: 12, screen_pos: { x: 2700, y: 1200 } }
      ],
      end_turn_btn: { visible: true, screen_pos: { x: 3400, y: 1500 } }
    };
    runLoopCycle({ mockState }).then(() => console.log('Simulation cycle succeeded.'));
  } else {
    startLoop();
  }
}

