import fs from 'fs';
import path from 'path';

// Disable TLS reject for aster.empeirion.cn self-signed cert
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export function getClaudeConfig() {
  try {
    const claudeSettingsPath = 'C:/Users/skift/.claude/settings.json';
    if (fs.existsSync(claudeSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      return {
        baseUrl: settings.env?.ANTHROPIC_BASE_URL || 'https://aster.empeirion.cn:44444',
        authToken: settings.env?.ANTHROPIC_AUTH_TOKEN || '',
        model: settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-5'
      };
    }
  } catch (err) {
    console.warn('Failed to load claude settings.json:', err.message);
  }

  return {
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://aster.empeirion.cn:44444',
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    model: 'claude-opus-5'
  };
}

/**
 * Ask Claude Opus 5 to analyze the game screenshot and output a structured GameState.
 */
export async function analyzeScreenshot(imagePath) {
  const config = getClaudeConfig();
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const systemPrompt = `You are an expert game vision perception model for Slay the Spire 2.
Your sole job is to accurately perceive the game screen and extract structured layout and entity data.
Always output pure JSON with no markdown formatting or chatter:
{
  "scene": "combat" | "reward" | "map" | "rest" | "event" | "main_menu" | "unknown",
  "player": {
    "hp": number,
    "max_hp": number,
    "block": number,
    "energy": number,
    "max_energy": number
  },
  "cards": [
    {
      "id": string,
      "name": string,
      "cost": number,
      "type": "attack" | "skill" | "power",
      "target_required": boolean,
      "screen_pos": { "x": number, "y": number },
      "playable": boolean
    }
  ],
  "enemies": [
    {
      "id": string,
      "name": string,
      "hp": number,
      "max_hp": number,
      "block": number,
      "intent_type": "attack" | "defend" | "buff" | "debuff" | "unknown",
      "intent_damage": number,
      "screen_pos": { "x": number, "y": number }
    }
  ],
  "end_turn_btn": {
    "visible": boolean,
    "screen_pos": { "x": number, "y": number }
  },
  "selectable_options": [
    {
      "name": string,
      "screen_pos": { "x": number, "y": number }
    }
  ]
}
Coordinates (screen_pos) should be absolute pixel coordinates corresponding to the screenshot resolution.`;

  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.authToken,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image
              }
            },
            {
              type: 'text',
              text: 'Identify current scene, player stats, cards in hand with coordinates, enemies with intents and coordinates, and end turn button.'
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const textContent = data.content?.find(c => c.type === 'text')?.text || '{}';
  
  // Clean potential markdown fences
  const cleaned = textContent.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
  return JSON.parse(cleaned);
}

if (process.argv[1]?.endsWith('vision_opus.mjs')) {
  console.log('Opus 5 Vision Module ready. Config:', getClaudeConfig());
}

