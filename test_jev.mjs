import { getJevModel, requestJev } from './src/jev_client.mjs';

const payload = {
  state: 'Hello, this is a test to verify if the Jev model API is working properly.',
  model: getJevModel(),
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
  const startTime = Date.now();
  try {
    const data = await requestJev(payload);
    const elapsed = Date.now() - startTime;
    if (!Number.isFinite(data.answers?.is_test?.noul) || !Object.hasOwn(payload.questions.sentiment.criteria, data.answers?.sentiment?.choice)) {
      throw new Error('Unexpected Jev answer contract');
    }
    console.log(JSON.stringify({ elapsed_ms: elapsed, ...data }, null, 2));
  } catch (err) {
    console.error('Jev smoke failed:', err.message);
    process.exitCode = 1;
  }
}

testApi();
