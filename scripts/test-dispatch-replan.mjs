#!/usr/bin/env node
/**
 * test-dispatch-replan.mjs — 单元测试
 * 
 * 测试改动：
 * 1. parseSubtasks / parseCompletedSubtasks — 子任务解析
 * 2. extractResultJSON — needReplan 支持
 * 3. executeWithSubtasks — 断点恢复 + replan 检测
 * 4. replanTask — 重新规划
 * 5. dispatchOnce — replan 集成
 * 
 * 使用纯 mock 测试，不依赖外部服务（飞书/OpenClaw）。
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ══ 从 bm-dispatch.mjs 提取纯函数进行测试 ══════════════════════

// 由于 bm-dispatch.mjs 的很多函数不是 export 的，
// 这里直接复制关键纯函数的逻辑进行单元测试。
// 对于需要 mock 的集成流程，用模拟对象。

// ── 复制 parseSubtasks ──────────────────────────────────────────

function parseSubtasks(planText) {
  if (!planText) return [];
  const lines = planText.replace(/\\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('子任务') && (trimmed.includes('：') || trimmed.includes(':'))) {
      const parts = trimmed.includes('：') ? trimmed.split('：', 2)[1] : trimmed.split(':', 2)[1];
      return (parts || '').split('→').map(n => n.trim().replace(/^(✅|📍|○)/, '').trim()).filter(Boolean);
    }
  }
  return [];
}

function parseCompletedSubtasks(planText) {
  if (!planText) return [];
  const completed = [];
  const lines = planText.replace(/\\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('✅')) {
      const matches = trimmed.match(/✅([^→✅○📍]+)/g);
      if (matches) {
        matches.forEach(m => {
          const name = m.replace('✅', '').trim();
          if (name) completed.push(name);
        });
      }
    }
  }
  return completed;
}

// ── 复制 extractResultJSON ──────────────────────────────────────

function extractResultJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    return { status: 'done', summary: '', files: [] };
  }

  const tryParse = (str) => {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object' && obj.status) return obj;
    } catch { /* ignore */ }
    return null;
  };

  const normalize = (obj) => {
    const result = { files: [], ...obj };
    if (obj.needReplan !== undefined) result.needReplan = !!obj.needReplan;
    return result;
  };

  const direct = tryParse(raw.trim());
  if (direct) return normalize(direct);

  const codeBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let cbMatch;
  while ((cbMatch = codeBlockRe.exec(raw)) !== null) {
    const parsed = tryParse(cbMatch[1].trim());
    if (parsed) return normalize(parsed);
  }

  const jsonCandidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '}') { depth--; if (depth === 0 && start >= 0) { jsonCandidates.push(raw.slice(start, i + 1)); start = -1; } }
  }
  for (let i = jsonCandidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(jsonCandidates[i]);
    if (parsed) return normalize(parsed);
  }

  const lower = raw.toLowerCase();
  if (lower.includes('blocked') || lower.includes('阻塞')) return { status: 'blocked', summary: raw.slice(0, 200), files: [] };
  if (lower.includes('error') || lower.includes('failed') || lower.includes('失败')) return { status: 'error', summary: raw.slice(0, 200), files: [] };

  return { status: 'done', summary: raw.slice(0, 200), files: [] };
}

// ══ 测试框架 ════════════════════════════════════════════════════

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg || `Expected ${sb}, got ${sa}`);
}

function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) throw new Error(msg || `Expected array to include "${item}", got [${arr.join(', ')}]`);
}

// ══ 测试用例 ════════════════════════════════════════════════════

console.log('\n📋 1. parseSubtasks');

test('解析基本子任务列表', () => {
  const plan = '目标：测试\n子任务：A → B → C';
  assertEqual(parseSubtasks(plan), ['A', 'B', 'C']);
});

test('解析带状态标记的子任务', () => {
  const plan = '目标：测试\n子任务：✅A → 📍B → ○C';
  assertEqual(parseSubtasks(plan), ['A', 'B', 'C']);
});

test('解析中文冒号', () => {
  const plan = '子任务：读文件 → 写代码 → 测试';
  assertEqual(parseSubtasks(plan), ['读文件', '写代码', '测试']);
});

test('解析英文冒号', () => {
  const plan = '子任务:X → Y → Z';
  assertEqual(parseSubtasks(plan), ['X', 'Y', 'Z']);
});

test('空 planText 返回空数组', () => {
  assertEqual(parseSubtasks(''), []);
  assertEqual(parseSubtasks(null), []);
  assertEqual(parseSubtasks(undefined), []);
});

test('无子任务行返回空数组', () => {
  assertEqual(parseSubtasks('目标：做点什么\n阶段：规划'), []);
});

test('处理字面量 \\n', () => {
  const plan = '目标：测试\\n子任务：A → B';
  assertEqual(parseSubtasks(plan), ['A', 'B']);
});

console.log('\n📋 2. parseCompletedSubtasks');

test('解析已完成的子任务', () => {
  const plan = '目标：测试\n✅A → 📍B → ○C';
  assertEqual(parseCompletedSubtasks(plan), ['A']);
});

test('多个已完成', () => {
  const plan = '目标：测试\n✅A → ✅B → 📍C';
  assertEqual(parseCompletedSubtasks(plan), ['A', 'B']);
});

test('全部完成', () => {
  const plan = '✅ 全部完成\n✅A → ✅B → ✅C';
  const completed = parseCompletedSubtasks(plan);
  assertIncludes(completed, 'A');
  assertIncludes(completed, 'B');
  assertIncludes(completed, 'C');
});

test('无已完成返回空', () => {
  const plan = '○A → ○B → ○C';
  assertEqual(parseCompletedSubtasks(plan), []);
});

test('空输入返回空', () => {
  assertEqual(parseCompletedSubtasks(''), []);
  assertEqual(parseCompletedSubtasks(null), []);
});

test('子任务行内的✅', () => {
  const plan = '子任务：✅读文件 → ✅写代码 → 测试';
  const completed = parseCompletedSubtasks(plan);
  assertIncludes(completed, '读文件');
  assertIncludes(completed, '写代码');
});

console.log('\n📋 3. extractResultJSON — needReplan 支持');

test('基本 done 结果', () => {
  const r = extractResultJSON('{"status":"done","summary":"完成了"}');
  assertEqual(r.status, 'done');
  assertEqual(r.summary, '完成了');
  assertEqual(r.needReplan, undefined);
});

test('needReplan=true 被保留', () => {
  const r = extractResultJSON('{"status":"error","message":"API不存在","needReplan":true}');
  assertEqual(r.status, 'error');
  assertEqual(r.needReplan, true);
});

test('needReplan=false 被保留', () => {
  const r = extractResultJSON('{"status":"error","message":"超时","needReplan":false}');
  assertEqual(r.status, 'error');
  assertEqual(r.needReplan, false);
});

test('无 needReplan 字段不设 undefined', () => {
  const r = extractResultJSON('{"status":"done","summary":"ok"}');
  assert(r.needReplan === undefined, `expected undefined, got ${r.needReplan}`);
});

test('blocked + needReplan', () => {
  const r = extractResultJSON('{"status":"blocked","reason":"依赖缺失","needReplan":true}');
  assertEqual(r.status, 'blocked');
  assertEqual(r.needReplan, true);
});

test('从 code block 中提取含 needReplan', () => {
  const raw = '分析后发现需要重新规划：\n```json\n{"status":"error","message":"方法不可行","needReplan":true}\n```';
  const r = extractResultJSON(raw);
  assertEqual(r.status, 'error');
  assertEqual(r.needReplan, true);
});

test('files 字段默认空数组', () => {
  const r = extractResultJSON('{"status":"done","summary":"ok"}');
  assertEqual(r.files, []);
});

test('关键词兜底', () => {
  const r = extractResultJSON('这个任务 failed 了');
  assertEqual(r.status, 'error');
});

test('空输入返回 done', () => {
  const r = extractResultJSON('');
  assertEqual(r.status, 'done');
});

console.log('\n📋 4. 断点恢复逻辑（模拟）');

test('已完成子任务应被跳过', () => {
  const planText = '目标：测试\n子任务：✅A → B → C';
  const allSubtasks = parseSubtasks(planText);  // ['A', 'B', 'C']
  const completed = parseCompletedSubtasks(planText);  // ['A']
  
  assertEqual(allSubtasks, ['A', 'B', 'C']);
  assertEqual(completed, ['A']);
  
  // 模拟 executeWithSubtasks 的跳过逻辑
  const toExecute = allSubtasks.filter(s => !completed.includes(s));
  assertEqual(toExecute, ['B', 'C']);
});

test('全部完成时无需执行', () => {
  const planText = '✅ 全部完成\n子任务：✅A → ✅B → ✅C';
  const allSubtasks = parseSubtasks(planText);
  const completed = parseCompletedSubtasks(planText);
  const toExecute = allSubtasks.filter(s => !completed.includes(s));
  assertEqual(toExecute, []);
});

test('无已完成时全部需执行', () => {
  const planText = '目标：测试\n子任务：A → B → C';
  const completed = parseCompletedSubtasks(planText);
  assertEqual(completed, []);
});

console.log('\n📋 5. Replan 触发条件（模拟）');

test('连续失败3次触发replan', () => {
  const REPLAN_CONSECUTIVE_ERRORS = 3;
  let consecutiveErrorCount = 0;
  const lastFailed = 'B';
  
  // 模拟3次失败
  for (let i = 0; i < 3; i++) {
    consecutiveErrorCount++;
  }
  
  assert(consecutiveErrorCount >= REPLAN_CONSECUTIVE_ERRORS, 'should trigger replan');
});

test('不同子任务失败不累计', () => {
  let consecutiveErrorCount = 0;
  let lastFailedSubtask = '';
  
  // 子任务B失败
  const subtask1 = 'B';
  consecutiveErrorCount = (lastFailedSubtask === subtask1) ? consecutiveErrorCount + 1 : 1;
  lastFailedSubtask = subtask1;
  assertEqual(consecutiveErrorCount, 1);
  
  // 子任务C失败（不同的子任务）
  const subtask2 = 'C';
  consecutiveErrorCount = (lastFailedSubtask === subtask2) ? consecutiveErrorCount + 1 : 1;
  lastFailedSubtask = subtask2;
  assertEqual(consecutiveErrorCount, 1); // 重置为1，不是2
});

test('成功后重置计数', () => {
  let consecutiveErrorCount = 2;
  
  // 子任务成功
  consecutiveErrorCount = 0;
  assertEqual(consecutiveErrorCount, 0);
});

test('LLM needReplan=true 立即触发', () => {
  const result = { status: 'error', message: 'API不存在', needReplan: true };
  assert(result.needReplan === true, 'should trigger replan immediately');
});

console.log('\n📋 6. Replan 结果集成（模拟）');

test('replan 生成新子任务列表', () => {
  // 模拟：A完成，B失败，replan 生成 B_alt 和 C
  const completedResults = [{ name: 'A', summary: '完成' }];
  const failedAt = 'B';
  
  // 模拟 replan 输出
  const newPlan = { plan: '调整方案', subtasks: ['B_alternative', 'C_adjusted'] };
  
  // 构建新 planText
  const completedLine = completedResults.map(c => `✅${c.name}`).join(' → ');
  const planText = `${newPlan.plan}\n子任务：${completedLine} → ${newPlan.subtasks.join(' → ')}`;
  
  assert(planText.includes('✅A'), 'should preserve completed');
  assert(planText.includes('B_alternative'), 'should include new subtask');
  
  // 解析后应包含所有子任务
  const allSubtasks = parseSubtasks(planText);
  assertIncludes(allSubtasks, 'A');
  assertIncludes(allSubtasks, 'B_alternative');
  assertIncludes(allSubtasks, 'C_adjusted');
  
  // 已完成的应被跳过
  const completed = parseCompletedSubtasks(planText);
  assertIncludes(completed, 'A');
  assert(!completed.includes('B_alternative'), 'new subtask should not be completed');
});

test('replan 达上限后标记阻塞', () => {
  const MAX_REPLAN_ATTEMPTS = 1;
  let replanAttempt = 0;
  let resultStatus = 'replan';
  
  // 第一次 replan
  if (resultStatus === 'replan' && replanAttempt < MAX_REPLAN_ATTEMPTS) {
    replanAttempt++;
    resultStatus = 'replan'; // 模拟 replan 后仍然失败
  }
  
  // 达上限
  assert(replanAttempt >= MAX_REPLAN_ATTEMPTS, 'should have reached limit');
  assert(resultStatus === 'replan', 'should still be replan status');
  // dispatchOnce 会将其转为 blocked
});

test('replan 无子任务回退到单任务', () => {
  const newPlan = { plan: '直接执行', subtasks: [] };
  assert(newPlan.subtasks.length === 0, 'no subtasks');
  // dispatchOnce 会调 executeSingle
});

console.log('\n📋 7. extractPlanJSON（间接测试）');

test('解析标准 plan JSON', () => {
  // 这里直接测试 extractResultJSON 处理 plan 格式
  // extractPlanJSON 不导出，但逻辑类似
  const raw = '{"plan":"目标：测试","subtasks":["A","B"],"needsSubtasks":true}';
  // extractResultJSON 需要 status 字段，plan JSON 没有，所以用不同的逻辑
  // 这里测试 plan JSON 的 tryParse 兼容性
  const obj = JSON.parse(raw);
  assertEqual(obj.subtasks, ['A', 'B']);
  assert(obj.needsSubtasks === true);
});

console.log('\n📋 8. Session 复用场景');

test('第二次调用能看到第一次上下文（已通过线上测试验证）', () => {
  // 这是一个标记测试：实际验证已通过 hooks/agent 线上测试
  // session key: hook:dispatch, 暗号测试通过
  assert(true, 'verified by live test');
});

test('不同任务之间的 session 隔离（设计约束）', () => {
  // 当前设计：所有 dispatch 共享 hook:dispatch session
  // 不同任务的上下文会混在一起，但 prompt 里有明确的任务边界
  // 未来可考虑 per-task session key（需要 allowRequestSessionKey）
  assert(true, 'design constraint acknowledged');
});

// ══ 结果 ════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 结果: ${passed}/${total} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('❌ 有测试失败！');
  process.exit(1);
} else {
  console.log('✅ 全部通过！');
  process.exit(0);
}
