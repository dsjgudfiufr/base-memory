#!/usr/bin/env node
/**
 * test-dispatch-e2e.mjs — 端到端集成测试
 *
 * 真实测试 dispatch 全流程：
 * 1. 在 Bitable 创建一个简单测试任务
 * 2. 运行 dispatchOnce
 * 3. 验证任务状态变化（进行中 → 完成）
 * 4. 清理测试任务
 *
 * ⚠️ 需要网关运行 + hooks 配置正确
 * 用法: node scripts/test-dispatch-e2e.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dispatchOnce, lockStatus } from './bm-dispatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(__dirname, 'base_config.json');
const CONFIG_FALLBACK = resolve(__dirname, '../../scripts/base_config.json');
const CONFIG_PATH = existsSync(CONFIG_FILE) ? CONFIG_FILE : CONFIG_FALLBACK;
const OPENCLAW_CONFIG = resolve(process.env.HOME, '.openclaw/openclaw.json');

// ── 配置 ──────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadOpenClawConfig() {
  return JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf-8'));
}

// ── Feishu API ──────────────────────────────────────────────────

let _token = null;

async function getToken() {
  if (_token) return _token;
  const oc = loadOpenClawConfig();
  const acc = oc.channels.feishu.accounts.main;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: acc.appId, app_secret: acc.appSecret }),
  });
  const data = await res.json();
  _token = data.tenant_access_token;
  return _token;
}

async function api(method, path, body) {
  const token = await getToken();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://open.feishu.cn/open-apis${path}`, opts);
  return r.json();
}

// ── 测试辅助 ──────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(emoji, ...args) {
  console.log(`[${ts()}] ${emoji}`, ...args);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 主测试 ──────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const { app_token } = cfg;
  const taskTableId = cfg.tables.tasks.id;
  const logTableId = cfg.tables.logs.id;

  log('🧪', '=== 端到端测试开始 ===');

  // 0. 前置检查
  log('🔍', '检查网关...');
  try {
    const gwRes = await fetch(`http://localhost:18789/health`);
    if (!gwRes.ok) throw new Error(`Gateway health: ${gwRes.status}`);
    log('✅', '网关正常');
  } catch (err) {
    log('❌', `网关不可用: ${err.message}. 请先启动网关。`);
    process.exit(1);
  }

  log('🔍', '检查锁状态...');
  const ls = lockStatus();
  if (ls.locked) {
    log('⚠️', `有 dispatch 正在运行 (pid=${ls.pid}, task=${ls.taskId})`);
    log('💡', '等待完成或手动删除 /tmp/bm-dispatch.lock');
    process.exit(1);
  }
  log('✅', '无并发锁');

  // 1. 创建测试任务
  const testTaskName = `[E2E测试] 简单计算 ${Date.now()}`;
  log('📝', `创建测试任务: ${testTaskName}`);

  const createRes = await api('POST', `/bitable/v1/apps/${app_token}/tables/${taskTableId}/records`, {
    fields: {
      '任务名称': testTaskName,
      '原始指令': '计算 123 + 456 的结果，直接回答数字即可。这是一个端到端测试任务。',
      '状态': '🕐 待开始',
      '优先级': '🔴 紧急',
    },
  });

  if (createRes.code !== 0) {
    log('❌', `创建任务失败: [${createRes.code}] ${createRes.msg}`);
    process.exit(1);
  }

  const recordId = createRes.data.record.record_id;
  log('✅', `任务创建成功: ${recordId}`);

  // 2. 运行 dispatchOnce
  log('🚀', '开始 dispatchOnce...');
  const startTime = Date.now();

  let result;
  try {
    result = await dispatchOnce({ config: cfg });
  } catch (err) {
    log('❌', `dispatchOnce 异常: ${err.message}`);
    await cleanup(app_token, taskTableId, recordId);
    process.exit(1);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  log('📊', `dispatchOnce 完成 (${elapsed}s): ${JSON.stringify(result)}`);

  // 3. 验证结果
  let passed = 0;
  let failed = 0;

  function check(name, condition) {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}`);
      failed++;
    }
  }

  log('🔍', '验证结果...');
  await sleep(2000); // Bitable 一致性延迟

  // 检查 dispatch 结果
  check('dispatch 返回了结果', result !== null);
  check('任务 ID 匹配', result?.taskId === recordId);
  check('状态为 done', result?.status === 'done');
  check('有结果摘要', (result?.summary || '').length > 0);

  // 检查 Bitable 任务状态
  const taskRec = await api('GET', `/bitable/v1/apps/${app_token}/tables/${taskTableId}/records/${recordId}`);
  const taskFields = taskRec.data?.record?.fields || {};

  const status = fieldValue(taskFields, '状态');
  const planText = fieldValue(taskFields, '任务进展');
  const resultSummary = fieldValue(taskFields, '结果摘要');

  log('📋', `Bitable 状态: "${status}"`);
  log('📋', `任务进展: "${planText?.slice(0, 100)}"`);
  log('📋', `结果摘要: "${resultSummary?.slice(0, 100)}"`);

  check('Bitable 状态为已完成', status === '✅ 已完成');
  check('任务进展已写入', planText && planText.length > 0);
  check('结果摘要已写入', resultSummary && resultSummary.length > 0);

  // 检查日志表
  const logSearch = await api('POST', `/bitable/v1/apps/${app_token}/tables/${logTableId}/records/search`, {
    filter: {
      conjunction: 'and',
      conditions: [
        { field_name: '关联任务ID', operator: 'is', value: [recordId] },
      ],
    },
    page_size: 20,
  });

  const logCount = logSearch.data?.items?.length || 0;
  log('📋', `日志记录: ${logCount} 条`);
  check('有日志记录（至少1条）', logCount >= 1);

  // 检查锁已释放
  const finalLock = lockStatus();
  check('锁已释放', !finalLock.locked);

  // 4. 清理
  await cleanup(app_token, taskTableId, recordId);

  // 清理测试日志
  if (logSearch.data?.items) {
    for (const item of logSearch.data.items) {
      await api('DELETE', `/bitable/v1/apps/${app_token}/tables/${logTableId}/records/${item.record_id}`);
    }
    log('🧹', `清理了 ${logSearch.data.items.length} 条测试日志`);
  }

  // 5. 结果
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`📊 端到端测试: ${passed}/${passed + failed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log('❌ 有测试失败！');
    process.exit(1);
  } else {
    console.log('✅ 全部通过！');
  }
}

function fieldValue(fields, key) {
  const val = fields?.[key];
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(i => (typeof i === 'object' ? i.text || '' : String(i))).join('');
  if (typeof val === 'number') return String(val);
  return String(val);
}

async function cleanup(appToken, tableId, recordId) {
  log('🧹', `清理测试任务: ${recordId}`);
  try {
    await api('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`);
    log('✅', '测试任务已删除');
  } catch (err) {
    log('⚠️', `清理失败: ${err.message}`);
  }
}

main().catch(err => {
  log('💥', `致命错误: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
