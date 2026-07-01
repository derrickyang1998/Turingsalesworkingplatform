// TuringMarket v8.0 自动化验证脚本
// 在服务器运行后执行: node test_v8.js

const BASE = 'http://localhost:3002/api';
const TOKEN_URL = 'http://localhost:3002/api/auth/login';

let token = '';
let pass = 0, fail = 0;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { headers, ...opts });
  return r.json();
}

async function test(name, fn) {
  try {
    const result = await fn();
    if (result && result.error) {
      console.log(`❌ ${name}: ${result.error}`);
      fail++;
    } else {
      console.log(`✅ ${name}`);
      pass++;
    }
    return result;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

async function run() {
  console.log('\n🧪 TuringMarket v8.0 验证测试\n' + '='.repeat(50));

  // 1. 登录
  const login = await test('登录', async () => {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: process.env.SMOKE_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD || '' })
    });
    const d = await r.json();
    if (d.token) token = d.token;
    return d;
  });

  if (!token) {
    console.log('\n❌ 登录失败，无法继续测试\n');
    return;
  }

  // 2. 创建线索
  const lead = await test('创建线索', async () => {
    return api('/leads', {
      method: 'POST',
      body: JSON.stringify({ brand_name: '华为', company_name: '华为技术', industry: '3C', source: 'manual', notes: '测试线索' })
    });
  });
  const leadId = lead?.id;

  // 3. 获取线索列表
  await test('获取线索列表', async () => {
    const r = await api('/leads');
    return Array.isArray(r.leads) ? { ok: true } : { error: 'invalid' };
  });

  // 4. 更新线索
  await test('更新线索状态', async () => {
    if (!leadId) return { error: 'no lead id' };
    return api('/leads/' + leadId, {
      method: 'PUT',
      body: JSON.stringify({ status: 'qualified', lead_score: 80 })
    });
  });

  // 5. 线索转客户
  const conv = await test('线索转客户', async () => {
    if (!leadId) return { error: 'no lead id' };
    return api('/leads/' + leadId + '/convert', { method: 'POST' });
  });
  const custId = conv?.customer_id;

  // 6. 直接创建客户
  const cust = await test('直接创建客户', async () => {
    return api('/customers', {
      method: 'POST',
      body: JSON.stringify({ brand_name: 'Anker', company_name: '安克创新', industry: '3C', stage: 'lead', budget_estimate: '>50K', notes: '大客户' })
    });
  });
  const directCustId = cust?.id;

  // 7. 获取客户列表
  await test('获取客户列表', async () => {
    const r = await api('/customers');
    return Array.isArray(r.customers) ? { ok: true } : { error: 'invalid' };
  });

  // 8. 客户详情（360°面板）
  await test('客户详情 360°', async () => {
    if (!custId && !directCustId) return { error: 'no customer' };
    const id = directCustId || custId;
    const r = await api('/customers/' + id + '/detail');
    return r.customer ? { ok: true } : { error: 'no customer data' };
  });

  // 9. 创建商机
  const opp = await test('创建商机', async () => {
    const id = directCustId || custId;
    if (!id) return { error: 'no customer' };
    return api('/opportunities', {
      method: 'POST',
      body: JSON.stringify({ customer_id: id, name: 'YouTube 推广合作', value: 50000, win_probability: 70, channel_type: 'YouTube', expected_close_date: '2026-08-01' })
    });
  });

  // 10. 商机列表
  await test('获取商机列表', async () => {
    const r = await api('/opportunities');
    return Array.isArray(r.opportunities) ? { ok: true } : { error: 'invalid' };
  });

  // 11. 设置业绩目标
  await test('设置业绩目标', async () => {
    return api('/sales-targets', {
      method: 'POST',
      body: JSON.stringify({ user_id: 1, target_type: 'revenue', target_value: 500000, period: 'monthly', period_start: '2026-06-01', period_end: '2026-06-30' })
    });
  });

  // 12. 获取业绩数据
  await test('获取销售业绩', async () => {
    const r = await api('/sales-performance');
    return Array.isArray(r.performance) ? { ok: true } : { error: 'invalid' };
  });

  // 13. 公海池
  await test('公海池', async () => {
    const r = await api('/customers/sea-pool');
    return Array.isArray(r.customers) ? { ok: true } : { error: 'invalid' };
  });

  // 14. 仪表盘
  await test('仪表盘', async () => {
    const r = await api('/customers/dashboard');
    return r.pipeline ? { ok: true } : { error: 'invalid' };
  });

  // 15. 用户管理 - 新增用户
  await test('新增用户', async () => {
    return api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'test_v8_' + Date.now(), display_name: '测试用户', department: '商务一部', role: 'user' })
    });
  });

  // 16. 用户列表
  await test('获取用户列表', async () => {
    const r = await api('/admin/users');
    return Array.isArray(r.users) ? { ok: true } : { error: 'invalid' };
  });

  // 17. Admin 总览
  await test('Admin 总览', async () => {
    const r = await api('/admin/overview');
    return r.stats ? { ok: true } : { error: 'no stats' };
  });

  // 18. Token 用量
  await test('Token 用量记录', async () => {
    return api('/token-usage', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-chat', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, endpoint: 'test' })
    });
  });

  // 19. 收回公海
  if (directCustId) {
    await test('退回公海池', async () => {
      return api('/customers/' + directCustId + '/return-pool', { method: 'POST' });
    });
  }

  // 20. 认领客户
  if (directCustId) {
    await test('认领客户', async () => {
      return api('/customers/' + directCustId + '/claim', { method: 'POST' });
    });
  }

  // 结果
  console.log('\n' + '='.repeat(50));
  console.log(`📊 测试结果: ${pass} 通过, ${fail} 失败, ${pass+fail} 总计`);
  console.log(pass > 0 && fail === 0 ? '🎉 全部通过！' : fail > 0 ? '⚠️ 有失败项，需要修复' : '');
}

run().catch(e => console.error('脚本错误:', e));
