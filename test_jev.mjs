import fs from 'fs';
import path from 'path';

// Read .env without printing key
const envPath = path.join(process.cwd(), '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/TYPESAFE_API_KEY\s*=\s*([^\r\n]+)/);

if (!match) {
  console.error('Error: TYPESAFE_API_KEY not found in .env');
  process.exit(1);
}

const apiKey = match[1].trim();
const maskedKey = apiKey.slice(0, 10) + '...' + apiKey.slice(-6);
console.log(`Using API key: ${maskedKey}`);

const url = 'https://api.typesafe.ai/v1/systemone';

const payload = {
  state: 'Hello, this is a test to verify if the Jev model API is working properly.',
  model: 'jev-latest',
  questions: {
    is_test: {
      type: 'noul',
      instructions: 'Is this message a test or verification request?',
      criteria: {
        true: 'Explicitly mentions test or verification',
        false: 'Not a test'
      }
    },
    sentiment: {
      type: 'choice',
      instructions: 'What is the tone/nature of this message?',
      criteria: {
        neutral: 'Neutral or objective tone',
        positive: 'Positive or cheerful',
        negative: 'Negative or complaining'
      }
    }
  }
};

async function testApi() {
  console.log('Sending request to:', url);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const elapsed = Date.now() - startTime;
    console.log(`\nResponse Status: ${res.status} ${res.statusText} (${elapsed}ms)`);
    console.log('Response Headers:');
    for (const [k, v] of res.headers.entries()) {
      if (['x-request-id', 'content-type', 'ratelimit-limit', 'ratelimit-remaining', 'date'].includes(k.toLowerCase())) {
        console.log(`  ${k}: ${v}`);
      }
    }

    const text = await res.text();
    try {
      const data = JSON.parse(text);
      console.log('\nResponse Data:\n', JSON.stringify(data, null, 2));
    } catch {
      console.log('\nResponse Text:\n', text);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

testApi();
