import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/TYPESAFE_API_KEY\s*=\s*([^\r\n]+)/);

if (!match) {
  process.exit(1);
}

const apiKey = match[1].trim();
const url = 'https://api.typesafe.ai/v1/systemone';

const payload = {
  state: '客户反馈：你们的系统今天登录一直报500错误，严重影响我们上午的业务结算，请尽快修复！',
  model: 'jev-latest',
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const elapsed = Date.now() - startTime;
  const data = await res.json();
  console.log(`Status: ${res.status} OK (${elapsed}ms)`);
  console.log('Result:\n', JSON.stringify(data, null, 2));
}

testApi();
