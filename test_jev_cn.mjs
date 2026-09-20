import { getJevModel, requestJev } from './src/jev_client.mjs';

const payload = {
  state: '客户反馈：你们的系统今天登录一直报500错误，严重影响我们上午的业务结算，请尽快修复！',
  model: getJevModel(),
  questions: {
    urgency_level: {
      type: 'score',
      instructions: '评估客户反馈的紧急程度',
      criteria: ['常规咨询或轻微问题', '中度问题影响部分操作', '紧急故障严重阻断业务']
    },
    issue_category: {
      type: 'choice',
      instructions: '问题所属分类',
      criteria: {
        server_error: '服务不可用、5xx报错、崩溃',
        feature_request: '新功能建议与改进',
        billing: '账单与充值问题'
      }
    }
  }
};

async function testApi() {
  const startTime = Date.now();
  const data = await requestJev(payload);
  const elapsed = Date.now() - startTime;
  if (!Number.isFinite(data.answers?.urgency_level?.score) || !Object.hasOwn(payload.questions.issue_category.criteria, data.answers?.issue_category?.choice)) {
    throw new Error('Unexpected Jev answer contract');
  }
  console.log(`Jev request succeeded (${elapsed}ms)`);
  console.log('Result:\n', JSON.stringify(data, null, 2));
}

testApi().catch(error => { console.error('Jev smoke failed:', error.message); process.exitCode = 1; });
