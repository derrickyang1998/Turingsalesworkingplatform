#!/usr/bin/env node
// TuringMarket server smoke test
const http = require('http');
const BASE = 'http://localhost:3002';

async function main() {
  const tests = [];

  // Test health
  tests.push(fetchJSON('/api/health').then(d => {
    if (d.status === 'ok') console.log('✅ /api/health');
    else throw new Error('Health failed');
  }));

  // Test login
  let token;
  tests.push(fetchJSON('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({username:'admin',password:'turing2026'}),
    headers: {'Content-Type':'application/json'}
  }).then(d => {
    if (d.token) { token = d.token; console.log('✅ Login OK'); }
    else throw new Error('Login failed');
  }));

  await Promise.all(tests);

  const auth = {headers: {'Authorization': 'Bearer ' + token}};

  const apiTests = [
    ['GET', '/api/auth/me', null, 'auth me'],
    ['GET', '/api/customers/stats', null, 'customer stats'],
    ['GET', '/api/users', null, 'users list'],
    ['GET', '/api/dashboard/stats', null, 'dashboard'],
    ['GET', '/api/knowledge/categories', null, 'knowledge cats'],
    ['GET', '/api/workflow/templates', null, 'workflow templates'],
    ['GET', '/api/workflow/tasks', null, 'workflow tasks'],
    ['GET', '/api/workflow/instances', null, 'workflow instances'],
  ];

  for (const [method, path] of apiTests) {
    try {
      const d = await fetchJSON(path, {...auth, method});
      console.log('✅ ' + path);
    } catch(e) {
      console.log('❌ ' + path + ': ' + e.message);
    }
  }

  console.log('\n🎉 All tests complete!');
}

function fetchJSON(path, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const parts = {hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET'};
    if (opts) Object.assign(parts, opts);
    const req = http.request(parts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(res.statusCode + ': ' + data.substring(0, 80)));
        else resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
