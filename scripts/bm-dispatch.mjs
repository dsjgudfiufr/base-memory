#!/usr/bin/env node
/**
 * bm-dispatch.mjs — 代码驱动的任务调度器核心循环
 *
 * 独立 Node 进程：循环查 Base 任务表 → 拼 prompt → spawn LLM session
 * → 等结果 → 解析结果写表 → 下一个任务。
 *
 * 用法:
 *   node bm-dispatch.mjs                # 持续循环
 *   node bm-dispatch.mjs --once         # 执行一轮（测试用）
 *   import { dispatch, dispatchOnce } from './bm-dispatch.mjs'
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ─────────────────────────────────────────────────────────

const OPENCLAW_PORT = process.env.OPENCLAW_PORT || 18789;
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || resolve(process.env.HOME, '.openclaw/openclaw.json');
const CONFIG_FILE = resolve(__dirname, 'base_config.json');
// 如果 scripts 目录下没有 config，回退到上级 scripts/base_config.json
const CONFIG_PATH = existsSync(CONFIG_FILE)
  ? CONFIG_FILE
  : resolve(__dirname, '../../scripts/base_config.json');

const MAX_ERROR_RETRIES = parseInt(process.env.BT_MAX_ERROR_RETRIES || '5', 10);
const REPLAN_CONSECUTIVE_ERRORS = 3; // 同一子任务连续失败 N 次触发 replan
const MAX_REPLAN_ATTEMPTS = 1; // 每个任务最多 replan 次数（避免无限循环）
const POLL_INTERVAL_MS = parseInt(process.env.BT_POLL_INTERVAL_MS || '30000', 10); // 主循环间隔
const LLM_POLL_INTERVAL_MS = parseInt(process.env.BT_LLM_POLL_MS || '10000', 10);
const LLM_TIMEOUT_MS = parseInt(process.env.BT_LLM_TIMEOUT_MS || '600000', 10); // 10 min
const OWNER_OPEN_ID = process.env.BT_OWNER_OPEN_ID || '';

// 优先级排序权重（越小越高）
const PRIORITY_RANK = { '🔴 紧急': 0, '🟡 重要': 1, '🟢 普通': 2 };
const STATUS_RANK = { '🔄 进行中': 0, '⏸️ 已暂停': 1, '🕐 待开始': 2 };

// ── 日志 ─────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(emoji, ...args) {
  console.log(`[${ts()}] ${emoji}`, ...args);
}

// ── 并发锁 ───────────────────────────────────────────────────────

const LOCK_FILE = '/tmp/bm-dispatch.lock';
const LOCK_STALE_MS = parseInt(process.env.BT_LOCK_STALE_MS || '900000', 10); // 15 min

/**
 * 尝试获取排他锁。
 * 锁文件格式：{ pid, startTime, taskId? }
 * @returns {boolean} true 表示获得锁
 */
export function acquireLock(taskId) {
  if (existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const age = Date.now() - (lockData.startTime || 0);

      // 检查进程是否还活着
      let alive = false;
      if (lockData.pid) {
        try { process.kill(lockData.pid, 0); alive = true; } catch { alive = false; }
      }

      if (alive && age < LOCK_STALE_MS) {
        // 锁有效，另一个 dispatch 正在运行
        log('🔒', `锁被持有 (pid=${lockData.pid}, age=${Math.round(age / 1000)}s, task=${lockData.taskId || '?'})，跳过本轮`);
        return false;
      }

      // 锁过期或进程已死，清理
      log('🔓', `清理过期锁 (pid=${lockData.pid}, age=${Math.round(age / 1000)}s, alive=${alive})`);
      try { unlinkSync(LOCK_FILE); } catch {}
    } catch {
      // 锁文件损坏，删除
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }

  // 写入新锁
  const lockData = { pid: process.pid, startTime: Date.now(), taskId: taskId || null };
  writeFileSync(LOCK_FILE, JSON.stringify(lockData));
  return true;
}

/**
 * 释放锁。只释放自己持有的锁。
 */
export function releaseLock() {
  if (!existsSync(LOCK_FILE)) return;
  try {
    const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    if (lockData.pid === process.pid) {
      unlinkSync(LOCK_FILE);
      log('🔓', '锁已释放');
    }
  } catch {
    // 锁文件损坏，直接删
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

/**
 * 更新锁中的 taskId（执行过程中更新，方便调试）。
 */
function updateLockTask(taskId) {
  if (!existsSync(LOCK_FILE)) return;
  try {
    const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    if (lockData.pid === process.pid) {
      lockData.taskId = taskId;
      writeFileSync(LOCK_FILE, JSON.stringify(lockData));
    }
  } catch {}
}

/**
 * 检查锁状态（供外部查询）。
 * @returns {{ locked: boolean, pid?: number, age?: number, taskId?: string }}
 */
export function lockStatus() {
  if (!existsSync(LOCK_FILE)) return { locked: false };
  try {
    const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    const age = Date.now() - (lockData.startTime || 0);
    let alive = false;
    if (lockData.pid) {
      try { process.kill(lockData.pid, 0); alive = true; } catch { alive = false; }
    }
    return { locked: alive && age < LOCK_STALE_MS, pid: lockData.pid, age, taskId: lockData.taskId, alive };
  } catch {
    return { locked: false };
  }
}

// ── Token 计算（代码 diff 方式）──────────────────────────────────

const SESSION_DIR = resolve(process.env.HOME, '.openclaw/agents/main/sessions');
const SESSIONS_INDEX = resolve(SESSION_DIR, 'sessions.json');

/**
 * 动态查找 dispatch session 的 UUID。
 * 从 OpenClaw 的 sessions.json 索引文件中查找 hook:dispatch 对应的 sessionId。
 */
function findDispatchSessionId() {
  // 优先用环境变量（显式配置）
  if (process.env.BT_DISPATCH_SESSION_ID) return process.env.BT_DISPATCH_SESSION_ID;

  // 从 sessions.json 动态发现
  if (!existsSync(SESSIONS_INDEX)) return null;
  try {
    const index = JSON.parse(readFileSync(SESSIONS_INDEX, 'utf-8'));
    // 查找 key 包含 "hook:dispatch" 的条目
    for (const [key, val] of Object.entries(index)) {
      if (key.includes('hook:dispatch') && val.sessionId) {
        return val.sessionId;
      }
    }
  } catch {}
  return null;
}

/**
 * 从 session jsonl 文件读取最后一条 assistant 消息的 totalTokens。
 * 这个值是 OpenClaw 维护的累计 token 数，用于 diff 计算。
 */
function getSessionTotalTokens() {
  const sessionId = findDispatchSessionId();
  if (!sessionId) {
    log('⚠️', 'dispatch session 未找到，token 计算跳过');
    return 0;
  }

  const sessionFile = resolve(SESSION_DIR, `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) {
    log('⚠️', 'dispatch session 文件不存在，token 计算跳过');
    return 0;
  }

  try {
    const data = readFileSync(sessionFile, 'utf-8');
    const lines = data.split('\n').filter(l => l.trim());

    // 从末尾往前找最后一条有 usage.totalTokens 的 message
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message') {
          const totalTokens = entry.message?.usage?.totalTokens;
          if (totalTokens && totalTokens > 0) return totalTokens;
        }
      } catch {}
    }
  } catch (err) {
    log('⚠️', `读取 session token 失败: ${err.message}`);
  }
  return 0;
}

// ── 配置读取 ──────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadOpenClawConfig() {
  return JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf-8'));
}

// ── 飞书 API ─────────────────────────────────────────────────────

let _tokenCache = { val: null, exp: 0 };

async function getToken() {
  if (_tokenCache.val && Date.now() < _tokenCache.exp) return _tokenCache.val;
  const oc = loadOpenClawConfig();
  const acc = oc.channels.feishu.accounts.main;
  const res = await fetchJSON('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: acc.appId || process.env.FEISHU_APP_ID,
    app_secret: acc.appSecret || process.env.FEISHU_APP_SECRET,
  });
  _tokenCache.val = res.tenant_access_token;
  _tokenCache.exp = Date.now() + (res.expire || 7200) * 1000 - 60000;
  return _tokenCache.val;
}

async function fetchJSON(method, url, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

async function api(method, path, body) {
  const token = await getToken();
  const url = `https://open.feishu.cn/open-apis${path}`;
  return fetchJSON(method, url, body, { Authorization: `Bearer ${token}` });
}

// ── Base 辅助 ─────────────────────────────────────────────────

function fv(fields, key) {
  const val = fields?.[key];
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(i => (typeof i === 'object' ? i.text || '' : String(i))).join('');
  if (typeof val === 'boolean') return val ? '✅' : '☐';
  if (typeof val === 'number') return String(val);
  return String(val);
}

async function searchRecords(appToken, tableId, filterBody) {
  const body = { page_size: 100, ...filterBody };
  const r = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, body);
  if (r.code !== 0) {
    log('⚠️', `searchRecords 失败: [${r.code}] ${r.msg}`);
    return [];
  }
  return r.data?.items || [];
}

async function updateRecord(appToken, tableId, recordId, fields) {
  return api('PUT', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, { fields });
}

async function getRecord(appToken, tableId, recordId) {
  const r = await api('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`);
  return r.data?.record || null;
}

async function addLogRecord(appToken, logTableId, fields) {
  return api('POST', `/bitable/v1/apps/${appToken}/tables/${logTableId}/records`, { fields });
}

// ── 子任务解析 ────────────────────────────────────────────────────

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

/**
 * 从 planText 中解析已完成的子任务列表。
 */
function parseCompletedSubtasks(planText) {
  if (!planText) return [];
  const completed = [];
  const lines = planText.replace(/\\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // 匹配进度行中的 ✅ 标记
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

function findFirstIncompleteSubtask(planText) {
  if (!planText) return null;
  const subtasks = parseSubtasks(planText);
  if (!subtasks.length) return null;
  for (const name of subtasks) {
    // 已完成的子任务在 planText 中会有 ✅ 前缀
    if (!planText.includes(`✅${name}`)) return name;
  }
  return null; // 全部完成
}

// ── 任务获取与排序 ────────────────────────────────────────────────

/**
 * 中断检查：子任务完成后，检查是否有更高优先级任务需要抢占。
 * 如果有，暂停当前任务（保存断点到任务进展字段），返回 preempted 状态。
 */
async function checkPreemption(cfg, currentRecordId, allSubtasks, completedResults, planText) {
  try {
    const nextTask = await fetchNextTask(cfg);
    if (!nextTask) return null; // 没有其他任务

    // 如果最高优先级任务还是当前任务，继续执行
    if (nextTask.record_id === currentRecordId) return null;

    // 比较优先级
    const currentRec = await getRecord(cfg.app_token, cfg.tables.tasks.id, currentRecordId);
    const currentPriority = PRIORITY_RANK[fv(currentRec?.fields, '优先级')] ?? 9;
    const nextPriority = PRIORITY_RANK[fv(nextTask.fields, '优先级')] ?? 9;

    // 只有更高优先级才抢占（数字越小优先级越高）
    if (nextPriority >= currentPriority) return null;

    const nextName = fv(nextTask.fields, '任务名称');
    const doneCount = completedResults.filter(r => !r.summary.includes('恢复跳过')).length;
    log('⚡', `中断！更高优先级任务: ${fv(nextTask.fields, '优先级')} ${nextName}`);

    // 保存断点：更新任务进展字段（已完成的子任务标 ✅，未完成的保留 ○）
    const breakpointLine = allSubtasks.map(s => {
      if (completedResults.some(r => r.name === s)) return `✅${s}`;
      return `○${s}`;
    }).join(' → ');
    const breakpointText = `${planText.split('\n')[0]}\n⏸️ 已暂停 (${doneCount}/${allSubtasks.length}) — 被 ${nextName} 抢占\n子任务：${breakpointLine}`;

    await updateField(cfg, currentRecordId, '任务进展', breakpointText);
    await updateField(cfg, currentRecordId, '状态', '⏸️ 已暂停');

    log('⏸️', `任务已暂停 (${doneCount}/${allSubtasks.length}), 断点已保存`);

    return {
      taskId: currentRecordId,
      status: 'preempted',
      summary: `被 ${nextName} 抢占，已完成 ${doneCount}/${allSubtasks.length} 子任务`,
      preemptedBy: nextTask.record_id,
    };
  } catch (err) {
    log('⚠️', `中断检查失败（不阻塞）: ${err.message}`);
    return null; // 检查失败不影响当前执行
  }
}

async function fetchNextTask(cfg) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;

  const candidates = await searchRecords(app_token, tableId, {
    filter: {
      conjunction: 'or',
      conditions: [
        { field_name: '状态', operator: 'is', value: ['🔄 进行中'] },
        { field_name: '状态', operator: 'is', value: ['⏸️ 已暂停'] },
        { field_name: '状态', operator: 'is', value: ['🕐 待开始'] },
      ],
    },
    field_names: ['任务名称', '状态', '优先级', '执行序号', '错误次数', '任务进展', '原始指令'],
    page_size: 50,
  });

  if (!candidates.length) return null;

  // 排序：优先级 → 状态（进行中优先） → 序号
  candidates.sort((a, b) => {
    const af = a.fields || {}, bf = b.fields || {};
    const pa = PRIORITY_RANK[fv(af, '优先级')] ?? 9;
    const pb = PRIORITY_RANK[fv(bf, '优先级')] ?? 9;
    if (pa !== pb) return pa - pb;
    const sa = STATUS_RANK[fv(af, '状态')] ?? 9;
    const sb = STATUS_RANK[fv(bf, '状态')] ?? 9;
    if (sa !== sb) return sa - sb;
    const seqA = parseInt(fv(af, '执行序号') || '999', 10);
    const seqB = parseInt(fv(bf, '执行序号') || '999', 10);
    return seqA - seqB;
  });

  return candidates[0];
}

// ── 状态更新 ──────────────────────────────────────────────────────

async function markInProgress(cfg, recordId, subtaskName) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  const fields = { '状态': '🔄 进行中' };

  if (subtaskName) {
  }

  // 如果是待开始，补开始时间
  const rec = await getRecord(app_token, tableId, recordId);
  if (rec && !rec.fields?.['开始执行时间']) {
    fields['开始执行时间'] = Date.now();
  }

  await updateRecord(app_token, tableId, recordId, fields);
  log('🔄', `任务状态 → 进行中: ${recordId}${subtaskName ? ` [${subtaskName}]` : ''}`);
}

async function markDone(cfg, recordId, summary) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  const fields = {
    '状态': '✅ 已完成',
    '完成时间': Date.now(),
  };
  if (summary) fields['结果摘要'] = summary.slice(0, 200);
  await updateRecord(app_token, tableId, recordId, fields);
  log('✅', `任务完成: ${recordId}`);
}

// ── 上下文卸载：任务完成后把发现写入日志表，然后清理 session ──

/**
 * 从 LLM 输出中提取 findings JSON。
 */
function extractFindingsJSON(raw) {
  const fallback = { findings: [], decisions: [], resources: [] };
  if (!raw || typeof raw !== 'string') return fallback;

  const tryParse = (str) => {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object' && ('findings' in obj || 'decisions' in obj || 'resources' in obj)) return obj;
    } catch {}
    return null;
  };

  // 直接解析
  const direct = tryParse(raw.trim());
  if (direct) return { ...fallback, ...direct };

  // 从 code block 提取
  const re = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const p = tryParse(m[1].trim());
    if (p) return { ...fallback, ...p };
  }

  // 贪心匹配 JSON 对象
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '}') { depth--; if (depth === 0 && start >= 0) {
      const p = tryParse(raw.slice(start, i + 1));
      if (p) return { ...fallback, ...p };
      start = -1;
    }}
  }

  return fallback;
}

/**
 * 任务完成后，让 session 里的 LLM 总结关键发现，代码写入日志表。
 * 这样即使 session 被清理，发现仍持久化在 Bitable 中。
 */
async function unloadFindings(task, cfg) {
  const recordId = task.record_id;
  const logTableId = cfg.tables?.logs?.id;
  if (!logTableId) return;

  try {
    const prompt = `任务已完成。请回顾刚才的执行过程，总结关键发现。用 JSON 格式输出：
\`\`\`json
{
  "findings": ["重要发现1", "重要发现2"],
  "decisions": ["做出的技术决策及理由"],
  "resources": ["产出文件路径或有用URL"]
}
\`\`\`
规则：
- 每条内容简洁（≤100字）
- 只记有长期价值的发现，不记琐碎步骤
- 没有就留空数组
- 只输出 JSON`;

    const raw = await callLLM(prompt, { rawOutput: true });
    const parsed = extractFindingsJSON(raw);

    let count = 0;
    for (const f of (parsed.findings || []).slice(0, 5)) {
      if (f && f.length > 2) {
        await writeLog(cfg, recordId, '🔍 发现', f.slice(0, 500));
        count++;
      }
    }
    for (const d of (parsed.decisions || []).slice(0, 3)) {
      if (d && d.length > 2) {
        await writeLog(cfg, recordId, '🧭 决策', d.slice(0, 500));
        count++;
      }
    }
    for (const r of (parsed.resources || []).slice(0, 5)) {
      if (r && r.length > 2) {
        await writeLog(cfg, recordId, '📦 资源', r.slice(0, 500));
        count++;
      }
    }

    log('📤', `上下文卸载: ${count} 条发现写入日志表`);
  } catch (err) {
    log('⚠️', `上下文卸载失败（不阻塞）: ${err.message}`);
  }
}

/**
 * 重置 dispatch session，为下一个任务提供干净的上下文。
 * 通过发送一条清场消息，让 LLM 知道新任务即将开始。
 */
async function resetDispatchSession(cfg) {
  try {
    const oc = loadOpenClawConfig();
    const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN || oc.hooks?.token || '';
    const port = OPENCLAW_PORT;

    if (!hooksToken) return;

    // 发送一条系统级清场消息
    const res = await fetch(`http://localhost:${port}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({
        message: '【系统】上一个任务已结束。清除之前的任务上下文。从现在起，你将执行全新的任务。之前的对话内容不再相关。回复"已就绪"即可。',
        deliver: false,
        name: 'session-reset',
        timeoutSeconds: 30,
      }),
    });

    if (res.ok) {
      // 等待 session 处理清场消息
      await new Promise(r => setTimeout(r, 5000));
      log('🧹', 'dispatch session 已清场');
    }
  } catch (err) {
    log('⚠️', `session 清场失败（不阻塞）: ${err.message}`);
  }
}

/**
 * 更新任务表的单个字段。
 */
async function updateField(cfg, recordId, fieldName, value) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  await updateRecord(app_token, tableId, recordId, { [fieldName]: value });
}

async function markSubtaskDone(cfg, recordId, subtaskName, summary) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  const logTableId = cfg.tables.logs.id;

  const rec = await getRecord(app_token, tableId, recordId);
  if (!rec) return;

  let planText = fv(rec.fields, '任务进展') || '';
  const subtasks = parseSubtasks(planText);

  // 标记完成
  planText = planText.replace(subtaskName, `✅${subtaskName}`).replace('✅✅', '✅');

  const doneCount = subtasks.filter(s => planText.includes(`✅${s}`)).length;
  const allDone = doneCount === subtasks.length;

  const fields = { '任务进展': planText };
  if (allDone) {
    fields['状态'] = '✅ 已完成';
    fields['完成时间'] = Date.now();
    fields['结果摘要'] = `全部 ${subtasks.length} 个子任务已完成`;
  } else {
    const next = subtasks.find(s => !planText.includes(`✅${s}`));
  }

  await updateRecord(app_token, tableId, recordId, fields);

  // 写 milestone 日志
  await addLogRecord(app_token, logTableId, {
    '关联任务ID': recordId,
    '类型': '🏁 里程碑',
    '内容': `[${subtaskName}] ✅ 完成：${(summary || '').slice(0, 300)}`,
  });

  log('✅', `子任务完成: ${subtaskName} [${doneCount}/${subtasks.length}]`);
  return allDone;
}

async function incrementErrorCount(cfg, recordId, errorMsg) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  const logTableId = cfg.tables.logs.id;

  const rec = await getRecord(app_token, tableId, recordId);
  const curCount = parseInt(fv(rec?.fields, '错误次数') || '0', 10);
  const newCount = curCount + 1;

  await updateRecord(app_token, tableId, recordId, { '错误次数': newCount });

  // 写 error 日志
  await addLogRecord(app_token, logTableId, {
    '关联任务ID': recordId,
    '类型': '❌ 错误',
    '内容': (errorMsg || 'unknown error').slice(0, 500),
  });

  log('❌', `错误 #${newCount}/${MAX_ERROR_RETRIES}: ${recordId}`);

  if (newCount >= MAX_ERROR_RETRIES) {
    // 自动 block
    await updateRecord(app_token, tableId, recordId, { '状态': '🚧 阻塞中' });
    log('🚧', `任务已自动阻塞（错误达上限）: ${recordId}`);

    // 发飞书通知
    await notifyOwner(cfg, recordId, fv(rec?.fields, '任务名称'), newCount, errorMsg);
    return true; // blocked
  }

  // 更新阶段显示 ⚠️
  const phase = fv(rec?.fields, '任务进展') || '';
  if (!phase.startsWith('⚠️')) {
    await updateRecord(app_token, tableId, recordId, {
    });
  }

  return false; // not blocked, can retry
}

async function markBlocked(cfg, recordId, reason) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;
  await updateRecord(app_token, tableId, recordId, { '状态': '🚧 阻塞中' });
  log('🚧', `任务阻塞: ${recordId} — ${reason}`);
}

// ── 飞书通知 ──────────────────────────────────────────────────────

async function notifyOwner(cfg, taskId, taskName, errorCount, lastError) {
  if (!OWNER_OPEN_ID) {
    log('⚠️', '未配置 BT_OWNER_OPEN_ID，跳过飞书通知');
    return;
  }
  const msg = [
    '🚨 任务出错过多，需要您介入！',
    '',
    `📋 任务：${taskName || taskId}`,
    `❌ 已失败：${errorCount} 次（上限 ${MAX_ERROR_RETRIES} 次）`,
    `📝 最近错误：${(lastError || '').slice(0, 200)}`,
    '',
    '任务已自动标记为【阻塞中】，等待您处理。',
  ].join('\n');

  await api('POST', '/im/v1/messages?receive_id_type=open_id', {
    receive_id: OWNER_OPEN_ID,
    msg_type: 'text',
    content: JSON.stringify({ text: msg }),
  });
  log('📨', `已通知 owner: ${taskId}`);
}

// ── Prompt 构建 ──────────────────────────────────────────────────

/**
 * 从 Base 读取任务完整信息，拼装 LLM prompt。
 * @param {object} taskRecord - Base 任务记录
 * @param {string|null} subtaskName - 当前子任务名（无子任务时为 null）
 * @param {object} cfg - base_config
 * @returns {Promise<string>} prompt 文本
 */
export async function buildPrompt(taskRecord, subtaskName, cfg) {
  const fields = taskRecord.fields || {};
  const recordId = taskRecord.record_id;
  const name = fv(fields, '任务名称');
  const instruction = fv(fields, '原始指令');
  const plan = fv(fields, '任务进展');
  

  // ── 解析子任务进度 ──────────────────────────────────────────────
  const progress = fv(fields, '任务进展');
  const subtasks = parseSubtasks(plan);
  let progressLines = '';
  if (subtasks.length > 0) {
    progressLines = subtasks.map(s => {
      const done = plan && plan.includes(`✅${s}`);
      if (done) return `✅ ${s}`;
      if (subtaskName && s === subtaskName) return `📍 ${s} ← 当前`;
      return `○ ${s}`;
    }).join('\n');
  }

  // ── 从日志表读取最近日志 ────────────────────────────────────────
  const logTableId = cfg.tables?.logs?.id;
  let logLines = '';
  const previousFiles = [];

  if (logTableId && recordId) {
    try {
      const logRecords = await searchRecords(cfg.app_token, logTableId, {
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '关联任务ID', operator: 'is', value: [recordId] },
          ],
        },
        field_names: ['类型', '内容', '阶段', '记录时间'],
        sort: [{ field_name: '记录时间', desc: true }],
        page_size: 10,
      });

      if (logRecords.length > 0) {
        const relevantTypes = ['finding', 'decision', 'error', 'resource',
          '🔍 发现', '🧭 决策', '❌ 错误', '📦 资源', '🏁 里程碑',
          '📋 计划', '📊 进度', '🔧 工具'];
        const logs = logRecords.map(r => {
          const lf = r.fields || {};
          const type = fv(lf, '类型');
          const content = fv(lf, '内容');
          return { type, content };
        }).filter(l => l.content);

        logLines = logs.map(l => `- [${l.type}] ${l.content}`).join('\n');

        // 从 resource 类型日志中提取文件路径
        logs.forEach(l => {
          const typeStr = (l.type || '').toLowerCase();
          if (typeStr.includes('resource') || typeStr.includes('资源')) {
            const pathMatch = l.content.match(/(?:文件|file)[：:]\s*(\S+)/i);
            if (pathMatch) previousFiles.push(pathMatch[1]);
          }
        });
      }
    } catch (err) {
      // 日志表查询失败不阻塞 prompt 构建
      log('⚠️', `buildPrompt: 日志查询失败，跳过: ${err.message}`);
    }
  }

  // ── 拼装 prompt ─────────────────────────────────────────────────
  const parts = [];

  parts.push(`## 任务目标\n${name}`);

  if (subtaskName) {
    // 子任务模式：只传当前子任务信息，不传完整原始指令（防止 LLM 越界做其他步骤）
    let subtaskDesc = '';
    if (plan) {
      const planLines = plan.replace(/\\n/g, '\n').split('\n');
      for (const line of planLines) {
        if (line.includes(subtaskName) && (line.includes('：') || line.includes(':'))) {
          const sep = line.includes('：') ? '：' : ':';
          const afterName = line.split(sep).slice(1).join(sep).trim();
          if (afterName && !afterName.startsWith('✅') && !afterName.startsWith('📍')) {
            subtaskDesc = afterName;
          }
          break;
        }
      }
    }

    if (progressLines) {
      parts.push(`## 当前进度\n${progressLines}`);
    }

    parts.push(`## 当前子任务\n名称：${subtaskName}${subtaskDesc ? `\n要求：${subtaskDesc}` : ''}\n\n⚠️ 重要：只执行当前子任务「${subtaskName}」，不要做其他子任务。完成后立即写结果文件。`);
  } else {
    // 单任务模式：传完整信息
    if (instruction) {
      parts.push(`## 原始指令\n${instruction}`);
    }

    if (plan) {
      parts.push(`## 整体规划\n${plan}`);
    }

    if (progressLines) {
      parts.push(`## 当前进度\n${progressLines}`);
    } else if (progress) {
      parts.push(`## 当前进度\n${progress}`);
    }
  }

  if (logLines) {
    parts.push(`## 关键发现和决策（从日志表）\n${logLines}`);
  }

  if (previousFiles.length > 0) {
    parts.push(`## 产出物路径\n${previousFiles.join('\n')}`);
  }

  parts.push([
    '## 输出格式',
    '完成后输出 JSON：{"status":"done","summary":"一句话摘要","files":["产出文件路径"]}',
    '遇到阻塞：{"status":"blocked","reason":"原因"}',
    '失败：{"status":"error","message":"错误信息"}',
  ].join('\n'));

  return parts.join('\n\n');
}

// ── 结果解析 + Base 写入 ──────────────────────────────────────

/**
 * 从 LLM 原始输出中提取结构化 JSON。
 * LLM 被要求输出 {"status":"done|error|blocked","summary":"...","files":[...]}
 * 但可能在 JSON 前后有其他文本，需要健壮提取。
 * @param {string} raw - LLM 原始输出
 * @returns {{ status: string, summary: string, files: string[], reason?: string, message?: string }}
 */
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

  // 标准化结果：保留 needReplan 字段
  const normalize = (obj) => {
    const result = { files: [], ...obj };
    if (obj.needReplan !== undefined) result.needReplan = !!obj.needReplan;
    return result;
  };

  // 1. 直接解析整个输出
  const direct = tryParse(raw.trim());
  if (direct) return normalize(direct);

  // 2. 从 markdown code block 中提取
  const codeBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let cbMatch;
  while ((cbMatch = codeBlockRe.exec(raw)) !== null) {
    const parsed = tryParse(cbMatch[1].trim());
    if (parsed) return normalize(parsed);
  }

  // 3. 贪心匹配：找包含 "status" 的 JSON 对象（支持嵌套大括号）
  const jsonCandidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        jsonCandidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // 从后往前尝试（最后一个 JSON 块通常是最终结果）
  for (let i = jsonCandidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(jsonCandidates[i]);
    if (parsed) return normalize(parsed);
  }

  // 4. 关键词兜底
  const lower = raw.toLowerCase();
  if (lower.includes('blocked') || lower.includes('阻塞')) {
    return { status: 'blocked', summary: raw.slice(0, 200), files: [] };
  }
  if (lower.includes('error') || lower.includes('failed') || lower.includes('失败')) {
    return { status: 'error', summary: raw.slice(0, 200), files: [] };
  }

  // 5. 默认 done，整个输出当 summary
  return { status: 'done', summary: raw.slice(0, 200), files: [] };
}

/**
 * 发送飞书通知到配置的 chat_id（block / 第5次失败时调用）。
 * 如果没配置 notify_chat_id，只写日志不发消息。
 */
async function sendNotification(cfg, title, body) {
  const chatId = cfg.notify_chat_id;
  if (!chatId) {
    log('⚠️', `未配置 notify_chat_id，跳过飞书通知: ${title}`);
    return;
  }
  try {
    await api('POST', '/im/v1/messages?receive_id_type=chat_id', {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: `${title}\n\n${body}` }),
    });
    log('📨', `飞书通知已发送: ${title}`);
  } catch (err) {
    log('⚠️', `飞书通知发送失败: ${err.message}`);
  }
}

/**
 * 写一条日志到执行日志表。如果没有 log_table_id 配置则跳过。
 */
async function writeLog(cfg, recordId, type, content, phase) {
  const logTableId = cfg.tables?.logs?.id;
  if (!logTableId) {
    log('⚠️', '未配置 log_table_id，跳过日志写入');
    return;
  }
  const fields = {
    '关联任务ID': recordId,
    '类型': type,
    '内容': (content || '').slice(0, 500),
  };
  if (phase) fields['阶段'] = phase;
  await addLogRecord(cfg.app_token, logTableId, fields);
}

/**
 * 解析 LLM 返回结果并更新 Base。
 *
 * @param {string} raw - LLM 原始输出
 * @param {object} task - Base 任务记录 { record_id, fields }
 * @param {string|null} subtask - 当前子任务名（无子任务时为 null）
 * @param {object} cfg - base_config
 * @returns {Promise<{ status: string, summary: string, files: string[] }>}
 */
export async function parseResult(raw, task, subtask, cfg) {
  const result = extractResultJSON(raw);
  const summary = result.summary || result.message || result.reason || '';
  const normalized = {
    status: result.status || 'done',
    summary: summary.slice(0, 200),
    files: Array.isArray(result.files) ? result.files : [],
  };

  // 如果没传 task/cfg，退化为纯解析（向后兼容）
  if (!task || !cfg) return normalized;

  const recordId = task.record_id;
  const fields = task.fields || {};
  const taskName = fv(fields, '任务名称');
  const { app_token } = cfg;
  const tableId = cfg.tables?.tasks?.id;

  try {
    switch (normalized.status) {
      // ── done ──────────────────────────────────────────────────
      case 'done': {
        if (subtask) {
          // 子任务完成：标记 ✅ + markSubtaskDone 内部已写 milestone 日志
          await markSubtaskDone(cfg, recordId, subtask, normalized.summary);
        } else {
          // 主任务完成
          await markDone(cfg, recordId, normalized.summary);
          // 写 milestone 日志（markDone 不写日志，这里补）
          await writeLog(cfg, recordId, '🏁 里程碑',
            `完成：${normalized.summary}`, fv(fields, '任务进展'));
        }
        break;
      }

      // ── error ─────────────────────────────────────────────────
      case 'error': {
        // 读当前错误次数 +1
        const rec = await getRecord(app_token, tableId, recordId);
        const curCount = parseInt(fv(rec?.fields, '错误次数') || '0', 10);
        const newCount = curCount + 1;

        // 更新错误次数
        await updateRecord(app_token, tableId, recordId, { '错误次数': newCount });

        const phase = fv(rec?.fields, '任务进展') || '';
        await updateRecord(app_token, tableId, recordId, {
        });

        // 写 error 日志
        await writeLog(cfg, recordId, '❌ 错误',
          `第${newCount}次失败：${normalized.summary}`, phase);

        log('❌', `错误 #${newCount}/${MAX_ERROR_RETRIES}: ${recordId}`);

        // 第 5 次：自动 block + 飞书通知
        if (newCount >= MAX_ERROR_RETRIES) {
          await updateRecord(app_token, tableId, recordId, { '状态': '🔒阻塞' });
          log('🔒', `任务因错误达上限自动阻塞: ${recordId}`);

          await sendNotification(cfg,
            `🚨 任务自动阻塞：${taskName || recordId}`,
            [
              `📋 任务：${taskName}`,
              `❌ 连续失败 ${newCount} 次（上限 ${MAX_ERROR_RETRIES}）`,
              `📝 最近错误：${normalized.summary}`,
              `🔒 已自动阻塞，需人工介入`,
            ].join('\n'));
        }
        break;
      }

      // ── blocked ───────────────────────────────────────────────
      case 'blocked': {
        await updateRecord(app_token, tableId, recordId, { '状态': '🔒阻塞' });
        log('🔒', `任务阻塞: ${recordId} — ${normalized.summary}`);

        // 写 blocked 日志
        await writeLog(cfg, recordId, '🔒 阻塞',
          `阻塞原因：${normalized.summary}`,
          fv(fields, '任务进展'));

        // 飞书通知
        await sendNotification(cfg,
          `🔒 任务阻塞：${taskName || recordId}`,
          [
            `📋 任务：${taskName}`,
            `🔒 阻塞原因：${normalized.summary}`,
            `需人工介入处理`,
          ].join('\n'));
        break;
      }

      default: {
        log('⚠️', `未知状态 "${normalized.status}"，按 done 处理`);
        if (subtask) {
          await markSubtaskDone(cfg, recordId, subtask, normalized.summary);
        } else {
          await markDone(cfg, recordId, normalized.summary);
          await writeLog(cfg, recordId, '🏁 里程碑',
            `完成（状态=${normalized.status}）：${normalized.summary}`,
            fv(fields, '任务进展'));
        }
      }
    }
  } catch (err) {
    log('⚠️', `parseResult Base 写入失败: ${err.message}`);
    // 写入失败不影响返回解析结果
  }

  return normalized;
}

// ── LLM 调用（通过 OpenClaw hooks/agent + 文件通信）──────────────

/**
 * 通过 OpenClaw /hooks/agent 触发隔离 session（有工具权限）。
 * LLM 不调 bm 命令，只把结果 JSON 写入约定文件。
 * dispatch 轮询文件获取结果，然后代码自动更新所有表状态。
 *
 * @param {string} prompt - 构建好的 prompt
 * @returns {Promise<string>} LLM 写入的结果 JSON 字符串
 */
async function callLLM(prompt, opts = {}) {
  const oc = loadOpenClawConfig();
  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN || oc.hooks?.token || '';
  const port = OPENCLAW_PORT;

  if (!hooksToken) {
    throw new Error('未找到 hooks token，请设置 OPENCLAW_HOOKS_TOKEN 或配置 openclaw.json hooks.token');
  }

  const dispatchId = Date.now();
  const resultFile = `/tmp/bm-dispatch-result-${dispatchId}.json`;

  // prompt 末尾追加结果文件指令（planTask 模式跳过）
  const finalPrompt = opts.rawOutput ? `${prompt}

## ⚠️ 必须执行：写结果文件
把你的 JSON 输出写入文件，这是调度器获取结果的唯一方式。
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
你的JSON输出
RESULT_EOF
\`\`\`
⚠️ 写结果文件是你的最后一步操作。不要执行任何其他操作。` : `${prompt}

## ⚠️ 必须执行：写结果文件
完成任务后，把结果 JSON 写入指定文件。这是调度器获取结果的唯一方式。
不要调用 bm 命令更新多维表格，调度器会自动处理。

成功：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"done","summary":"一句话描述你做了什么","files":["产出文件路径"]}
RESULT_EOF
\`\`\`

失败：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"error","message":"错误描述"}
RESULT_EOF
\`\`\`

阻塞（需要人工介入）：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"blocked","reason":"阻塞原因"}
RESULT_EOF
\`\`\`

⚠️ 写结果文件是你的最后一步操作。`;

  // 构建 hooks/agent 请求体（deliver: false — 中间过程不通知飞书）
  const body = {
    message: finalPrompt,
    deliver: false,
    timeoutSeconds: Math.floor(LLM_TIMEOUT_MS / 1000),
  };

  body.name = `dispatch-${dispatchId}`;
  log('🤖', `触发 hooks/agent, 结果文件: ${resultFile}`);

  const res = await fetch(`http://localhost:${port}/hooks/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hooksToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hooks/agent HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const { runId } = await res.json();
  log('📋', `runId: ${runId}, 轮询结果文件...`);

  // 轮询结果文件
  const startTime = Date.now();
  const pollInterval = 5000;
  const maxWait = LLM_TIMEOUT_MS;

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      if (existsSync(resultFile)) {
        const content = readFileSync(resultFile, 'utf-8').trim();
        if (content) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          log('📥', `结果文件就绪 (${elapsed}s), ${content.length} 字符`);
          try { unlinkSync(resultFile); } catch {}
          return content;
        }
      }
    } catch {}

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 30 === 0 && elapsed > 0) log('⏳', `等待 LLM 完成... ${elapsed}s`);
  }

  try { unlinkSync(resultFile); } catch {}
  throw new Error(`LLM 超时 (${Math.floor(maxWait / 1000)}s), 结果文件未生成`);
}

// ── 规划阶段 ─────────────────────────────────────────────────────

/**
 * 让 LLM 分析任务并输出规划 JSON。
 * @returns {{ plan: string, subtasks: string[] }}
 */
async function planTask(task, cfg) {
  const fields = task.fields || {};
  const taskName = fv(fields, '任务名称');
  const rawInstruction = fv(fields, '原始指令');

  const planPrompt = `你是一个任务规划器。分析以下任务，输出规划 JSON。

## 任务
名称：${taskName}
原始指令：${rawInstruction}

## 输出格式
只输出一个 JSON，不要其他文字：
\`\`\`json
{
  "plan": "目标：一句话\\n阶段：1-xxx → 2-xxx → 3-xxx",
  "subtasks": ["子任务A", "子任务B", "子任务C"],
  "needsSubtasks": true
}
\`\`\`

规则：
- 如果原始指令里提到了多个步骤、多个文件、多个操作，必须拆成子任务
- 只有真正一步就能完成的（如"查个时间"、"echo一句话"），才设 needsSubtasks=false
- 倾向于拆分：有疑问就拆
- plan 字段简洁，不超过 200 字
- 子任务名称简短明确

只输出 JSON。`;

  const raw = await callLLM(planPrompt, { rawOutput: true });
  
  // 独立解析规划 JSON（不要求 status 字段）
  const parsed = extractPlanJSON(raw);
  return parsed;
}

/**
 * 从 LLM 输出中提取规划 JSON（plan/subtasks/needsSubtasks）。
 */
function extractPlanJSON(raw) {
  const fallback = { plan: '', subtasks: [], needsSubtasks: false };
  if (!raw || typeof raw !== 'string') return fallback;

  const tryParse = (str) => {
    try {
      const obj = JSON.parse(str);
      if (obj && typeof obj === 'object' && ('plan' in obj || 'subtasks' in obj)) return obj;
    } catch {}
    return null;
  };

  // 直接解析
  const direct = tryParse(raw.trim());
  if (direct) return { ...fallback, ...direct };

  // 从 code block 提取
  const re = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const p = tryParse(m[1].trim());
    if (p) return { ...fallback, ...p };
  }

  // 贪心匹配 JSON 对象
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '}') { depth--; if (depth === 0 && start >= 0) {
      const p = tryParse(raw.slice(start, i + 1));
      if (p) return { ...fallback, ...p };
    }}
  }

  return fallback;
}

// ── Replan ────────────────────────────────────────────────────────

/**
 * 基于已完成子任务和失败原因，让 LLM 重新规划未完成部分。
 * 保留已完成的成果，只重新规划失败及后续的子任务。
 *
 * @param {object} task - Base 任务记录
 * @param {Array} completedResults - 已完成子任务 [{name, summary}]
 * @param {string} failedAt - 失败的子任务名
 * @param {string} reason - 失败/replan 原因
 * @param {object} cfg - base_config
 * @returns {{ plan: string, subtasks: string[] }}
 */
async function replanTask(task, completedResults, failedAt, reason, cfg) {
  const fields = task.fields || {};
  const taskName = fv(fields, '任务名称');
  const rawInstruction = fv(fields, '原始指令');
  const currentPlan = fv(fields, '任务进展');

  const completedSummary = completedResults
    .filter(r => !r.summary.includes('恢复跳过'))
    .map(r => `✅ ${r.name}：${r.summary}`)
    .join('\n') || '(无已完成子任务)';

  const replanPrompt = `你是一个任务重新规划器。之前的计划在执行过程中遇到了问题，需要你重新规划未完成的部分。

## 原始任务
名称：${taskName}
原始指令：${rawInstruction}

## 之前的计划
${currentPlan || '(无)'}

## 已完成的子任务（保留，不要重新规划）
${completedSummary}

## 失败点
子任务「${failedAt}」失败。
原因：${reason}

## 输出格式
只输出 JSON，不要其他文字：
\`\`\`json
{
  "plan": "基于已完成部分的新规划（一句话目标 + 新的子任务阶段）",
  "subtasks": ["新子任务X", "新子任务Y"],
  "reasoning": "为什么要这样重新规划"
}
\`\`\`

规则：
- 已完成的子任务不要包含在 subtasks 里
- 失败的子任务可以用不同方式重新表述
- 考虑失败原因，调整方法或拆分粒度
- 子任务名称简短明确
- plan 字段不超过 200 字

只输出 JSON。`;

  const raw = await callLLM(replanPrompt, { rawOutput: true });
  const parsed = extractPlanJSON(raw);

  // 如果 replan 没产出有效子任务，回退到单任务模式
  if (!parsed.subtasks || parsed.subtasks.length === 0) {
    log('⚠️', 'replan 未产出新子任务，回退到单任务模式');
    return { plan: parsed.plan || `重新执行：${taskName}`, subtasks: [] };
  }

  log('🔄', `Replan 完成: ${parsed.subtasks.length} 个新子任务 [${parsed.subtasks.join(', ')}]`);
  if (parsed.reasoning) log('💡', `Replan 理由: ${parsed.reasoning}`);

  return parsed;
}

// ── 单轮调度 ─────────────────────────────────────────────────────

/**
 * 执行一轮调度：取最高优先级任务 → 规划 → 逐步执行 → 更新结果。
 */
export async function dispatchOnce(opts = {}) {
  // ── 并发锁检查 ─────────────────────────────────────────────────
  if (!opts._skipLock && !acquireLock('checking')) {
    return { status: 'skipped', summary: '另一个 dispatch 正在运行' };
  }

  try {
    return await _dispatchOnceInner(opts);
  } finally {
    if (!opts._skipLock) releaseLock();
  }
}

async function _dispatchOnceInner(opts) {
  const cfg = opts.config || loadConfig();
  const task = await fetchNextTask(cfg);

  if (!task) {
    log('😴', '没有待处理任务');
    return null;
  }

  const recordId = task.record_id;
  const fields = task.fields || {};
  const taskName = fv(fields, '任务名称');
  const priority = fv(fields, '优先级');
  let planText = fv(fields, '任务进展');
  const errorCount = parseInt(fv(fields, '错误次数') || '0', 10);

  // 更新锁中的任务信息
  updateLockTask(`${taskName} (${recordId})`);
  log('🎯', `调度任务: ${priority} ${taskName}`);

  // Token T0：任务开始前记录 session 累计 token
  const tokenT0 = getSessionTotalTokens();
  log('📋', `record_id: ${recordId}, 错误次数: ${errorCount}, 任务进展: "${planText ? planText.slice(0, 50) : '(空)'}"`);

  // 更新状态为进行中
  await markInProgress(cfg, recordId);

  if (opts.dryRun) {
    const prompt = await buildPrompt(task, null, cfg);
    log('🏜️', 'DRY RUN — 跳过 LLM 调用');
    log('📝', `Prompt (${prompt.length} chars):\n${prompt.slice(0, 500)}...`);
    return { taskId: recordId, status: 'dry-run', summary: 'skipped' };
  }

  // ── 第一步：规划（如果还没有规划）──────────────────────────────
  let subtasks = [];
  if (!planText) {
    log('📝', '开始规划...');
    try {
      await updateField(cfg, recordId, '任务进展', '📝 规划中...');
      const planResult = await planTask(task, cfg);
      planText = planResult.plan || `目标：${taskName}`;
      subtasks = planResult.subtasks || [];

      if (subtasks.length > 0) {
        planText += `\n子任务：${subtasks.join(' → ')}`;
      }

      // 代码写表：任务进展
      await updateField(cfg, recordId, '任务进展', planText);
      log('📋', `规划完成: ${subtasks.length} 个子任务`);
    } catch (err) {
      log('⚠️', `规划失败: ${err.message}，直接执行`);
    }
  } else {
    // 从已有规划中解析全部子任务（包括已完成的，断点恢复在 executeWithSubtasks 内处理）
    subtasks = parseSubtasks(planText);
  }

  // ── 第二步：执行 ───────────────────────────────────────────────
  let result;
  let replanAttempt = 0;

  if (subtasks.length > 0) {
    result = await executeWithSubtasks(task, subtasks, planText, cfg);

    // ── Replan 处理 ──────────────────────────────────────────────
    while (result.status === 'replan' && replanAttempt < MAX_REPLAN_ATTEMPTS) {
      replanAttempt++;
      log('🔄', `触发 Replan (#${replanAttempt}): ${result.reason}`);

      // 写日志记录 replan 事件
      await writeLog(cfg, recordId, '🔄 重规划',
        `Replan #${replanAttempt}: ${result.reason}\n已完成: [${(result.completed || []).map(c => c.name).join(', ')}]\n失败于: ${result.failedAt}`);

      try {
        const newPlan = await replanTask(task, result.completed || [], result.failedAt, result.reason, cfg);

        if (newPlan.subtasks.length === 0) {
          // Replan 回退到单任务模式
          log('⚠️', 'Replan 回退到单任务模式');
          planText = newPlan.plan;
          await updateField(cfg, recordId, '任务进展', planText);
          result = await executeSingle(task, cfg);
          break;
        }

        // 构建新的 planText（保留已完成 + 新子任务）
        const completedLine = (result.completed || [])
          .filter(c => !c.summary.includes('恢复跳过'))
          .map(c => `✅${c.name}`).join(' → ');
        const newLine = newPlan.subtasks.map(s => `○${s}`).join(' → ');
        planText = `${newPlan.plan}\n子任务：${completedLine ? completedLine + ' → ' : ''}${newPlan.subtasks.join(' → ')}`;

        await updateField(cfg, recordId, '任务进展', planText);
        await updateField(cfg, recordId, '错误次数', 0); // 重置错误计数

        // 重新解析子任务列表（包含已完成的，executeWithSubtasks 会跳过）
        subtasks = parseSubtasks(planText);

        // 刷新 task fields 缓存
        const freshTask = await getRecord(cfg.app_token, cfg.tables.tasks.id, recordId);
        if (freshTask) task = freshTask;

        result = await executeWithSubtasks(task, subtasks, planText, cfg);
      } catch (err) {
        log('⚠️', `Replan 执行失败: ${err.message}`);
        result = { taskId: recordId, status: 'error', summary: `Replan 失败: ${err.message}` };
        break;
      }
    }

    // Replan 达上限仍失败
    if (result.status === 'replan') {
      log('🚧', `Replan 达上限 (${MAX_REPLAN_ATTEMPTS})，标记阻塞`);
      await updateField(cfg, recordId, '状态', '🚧 阻塞中');
      await notifyOwner(cfg, recordId, taskName, -1, `Replan ${MAX_REPLAN_ATTEMPTS} 次仍失败: ${result.reason}`);
      result = { taskId: recordId, status: 'blocked', summary: `Replan 失败: ${result.reason}` };
    }
  } else {
    result = await executeSingle(task, cfg);
  }

  // 写入 Token 开销（代码 diff 方式：T1 - T0）
  try {
    const tokenT1 = getSessionTotalTokens();
    const tokenDiff = tokenT1 - tokenT0;
    if (tokenDiff > 0) {
      await updateField(cfg, recordId, 'Token 开销', tokenDiff);
      log('🔢', `Token 开销: ${tokenDiff} (T0=${tokenT0}, T1=${tokenT1})`);
    } else if (tokenT1 > 0) {
      // T0 为 0（首次任务），直接用 T1
      await updateField(cfg, recordId, 'Token 开销', tokenT1);
      log('🔢', `Token 开销: ${tokenT1} (首次，无 T0)`);
    }
  } catch (err) {
    log('⚠️', `Token 计算失败: ${err.message}`);
  }

  // ── 第三步：上下文卸载 + session 清场 ─────────────────────────
  if (result.status === 'preempted') {
    // 被抢占时：清场 session（高优任务需要干净上下文），但不卸载发现
    await resetDispatchSession(cfg);
    log('⚡', `任务被抢占，dispatch 将继续执行高优任务`);
    return result;
  }

  // 任务完成/失败/阻塞后，把关键发现写入日志表，然后清理 session
  if (result.status === 'done' || result.status === 'blocked' || result.status === 'error') {
    // 只在任务完成时卸载发现（失败/阻塞时 session 里可能没有有价值的发现）
    if (result.status === 'done') {
      await unloadFindings(task, cfg);
    }
    // 无论成功失败，都清场 session（为下一个任务准备干净上下文）
    await resetDispatchSession(cfg);
  }

  return result;
}

/**
 * 逐步执行子任务，所有子任务复用同一个 session（省 token）。
 * Token 计算：最后一个子任务报告的 tokens 即为整个 session 的累计消耗。
 */
async function executeWithSubtasks(task, subtasks, planText, cfg) {
  const recordId = task.record_id;
  const allSubtasks = [...subtasks];
  const completedResults = [];

  // 断点恢复：从 planText 解析已完成子任务，跳过它们
  const alreadyCompleted = parseCompletedSubtasks(planText);
  if (alreadyCompleted.length > 0) {
    log('⏭️', `断点恢复：跳过已完成子任务 [${alreadyCompleted.join(', ')}]`);
  }

  // 连续失败计数器（用于 replan 判断）
  let consecutiveErrorCount = 0;
  let lastFailedSubtask = '';

  // Session 复用：所有子任务共享 hook:dispatch session（上下文自动保留）

  for (let i = 0; i < allSubtasks.length; i++) {
    const subtaskName = allSubtasks[i];

    // 跳过已完成的子任务（断点恢复）
    if (alreadyCompleted.includes(subtaskName)) {
      completedResults.push({ name: subtaskName, summary: '(已完成，恢复跳过)', files: [], tokens: 0 });
      continue;
    }

    const doneCount = completedResults.filter(r => !r.summary.includes('恢复跳过')).length;
    const progressLine = allSubtasks.map((s, j) => {
      if (completedResults.some(r => r.name === s)) return `✅${s}`;
      if (s === subtaskName) return `📍${s}`;
      return `○${s}`;
    }).join(' → ');

    // 代码写表：任务进展（N/M = 已完成N个/共M个）
    const progressText = `${planText.split('\n')[0]}\n📍 ${subtaskName} (${doneCount}/${allSubtasks.length})\n${progressLine}`;
    await updateField(cfg, recordId, '任务进展', progressText);
    log('📍', `子任务 (${doneCount}/${allSubtasks.length}): ${subtaskName}`);

    // 构建子任务 prompt（不含前序结果，session 上下文自动保留）
    const prompt = await buildPrompt(task, subtaskName, cfg);

    // 执行（复用 session）
    let rawOutput;
    try {
      rawOutput = await callLLM(prompt);
    } catch (err) {
      consecutiveErrorCount = (lastFailedSubtask === subtaskName) ? consecutiveErrorCount + 1 : 1;
      lastFailedSubtask = subtaskName;

      const blocked = await incrementErrorCount(cfg, recordId, `子任务 ${subtaskName} 失败: ${err.message}`);
      if (blocked) return { taskId: recordId, status: 'blocked', summary: err.message };

      // Replan 判断
      if (consecutiveErrorCount >= REPLAN_CONSECUTIVE_ERRORS) {
        return {
          taskId: recordId, status: 'replan',
          completed: completedResults, failedAt: subtaskName,
          reason: `子任务「${subtaskName}」连续失败 ${consecutiveErrorCount} 次`,
        };
      }
      return { taskId: recordId, status: 'error', summary: err.message };
    }

    // 解析结果
    const result = extractResultJSON(rawOutput);

    if (result.status === 'error') {
      consecutiveErrorCount = (lastFailedSubtask === subtaskName) ? consecutiveErrorCount + 1 : 1;
      lastFailedSubtask = subtaskName;

      const blocked = await incrementErrorCount(cfg, recordId, `子任务 ${subtaskName}: ${result.message || result.summary}`);
      if (blocked) return { taskId: recordId, status: 'blocked', summary: result.message };

      // LLM 显式请求 replan
      if (result.needReplan) {
        return {
          taskId: recordId, status: 'replan',
          completed: completedResults, failedAt: subtaskName,
          reason: result.reason || result.message || 'LLM 请求 replan',
        };
      }

      // 连续失败达阈值 → replan
      if (consecutiveErrorCount >= REPLAN_CONSECUTIVE_ERRORS) {
        return {
          taskId: recordId, status: 'replan',
          completed: completedResults, failedAt: subtaskName,
          reason: `子任务「${subtaskName}」连续失败 ${consecutiveErrorCount} 次`,
        };
      }

      return { taskId: recordId, status: 'error', summary: result.message || result.summary };
    }

    if (result.status === 'blocked') {
      // LLM 请求 replan 的 blocked 也触发 replan
      if (result.needReplan) {
        return {
          taskId: recordId, status: 'replan',
          completed: completedResults, failedAt: subtaskName,
          reason: result.reason || '子任务阻塞，需要重新规划',
        };
      }
      await updateField(cfg, recordId, '状态', '🔒阻塞');
      await updateField(cfg, recordId, '任务进展', `🔒 ${subtaskName} 阻塞: ${result.reason || ''}`);
      return { taskId: recordId, status: 'blocked', summary: result.reason };
    }

    // 子任务完成 → 重置连续失败计数
    consecutiveErrorCount = 0;
    lastFailedSubtask = '';
    completedResults.push({ name: subtaskName, summary: result.summary || 'done', files: result.files || [], tokens: result.tokens || 0 });
    log('✅', `子任务完成: ${subtaskName} — ${(result.summary || '').slice(0, 60)}`);

    // ── 中断检查：是否有更高优先级任务插入 ────────────────────────
    if (i < allSubtasks.length - 1) { // 最后一个子任务不检查（马上完成了）
      const preemptResult = await checkPreemption(cfg, recordId, allSubtasks, completedResults, planText);
      if (preemptResult) return preemptResult;
    }
  }

  // 全部子任务完成
  const finalProgress = allSubtasks.map(s => `✅${s}`).join(' → ');
  const finalSummary = completedResults
    .filter(r => !r.summary.includes('恢复跳过'))
    .map(r => r.summary).join('; ').slice(0, 200);

  await updateField(cfg, recordId, '任务进展', `✅ 全部完成\n${finalProgress}`);
  await markDone(cfg, recordId, finalSummary);
  log('🎉', `任务完成: ${allSubtasks.length} 个子任务全部完成`);

  return { taskId: recordId, status: 'done', summary: finalSummary };
}

/**
 * 直接执行单个任务（无子任务）。
 */
async function executeSingle(task, cfg) {
  const recordId = task.record_id;

  await updateField(cfg, recordId, '任务进展', '🔄 执行中...');

  const prompt = await buildPrompt(task, null, cfg);

  let rawOutput;
  try {
    rawOutput = await callLLM(prompt);
  } catch (err) {
    const blocked = await incrementErrorCount(cfg, recordId, `LLM 调用失败: ${err.message}`);
    return { taskId: recordId, status: blocked ? 'blocked' : 'error', summary: err.message };
  }

  const result = await parseResult(rawOutput, task, null, cfg);
  log('📊', `结果: status=${result.status}, summary=${(result.summary || result.message || '').slice(0, 80)}`);

  return { taskId: recordId, status: result.status, summary: result.summary || result.message || '', tokens: result.tokens || 0 };
}

// ── 主循环 ───────────────────────────────────────────────────────

/**
 * 持续调度循环。
 * @param {object} [opts] - 选项
 * @param {object} [opts.config] - 覆盖 base_config
 * @param {number} [opts.intervalMs] - 循环间隔（默认 30s）
 * @param {boolean} [opts.dryRun] - 只打印不执行 LLM
 * @param {AbortSignal} [opts.signal] - 用于外部停止循环
 */
export async function dispatch(opts = {}) {
  const intervalMs = opts.intervalMs || POLL_INTERVAL_MS;
  const signal = opts.signal || null;

  log('🚀', `bm-dispatch 启动 | 间隔=${intervalMs}ms | 最大错误=${MAX_ERROR_RETRIES} | port=${OPENCLAW_PORT}`);

  while (true) {
    if (signal?.aborted) {
      log('🛑', '收到停止信号，退出循环');
      break;
    }

    try {
      const result = await dispatchOnce(opts);
      if (result) {
        log('📌', `本轮结果: ${result.status} — ${(result.summary || '').slice(0, 60)}`);

        // 被抢占时立即进入下一轮（不等待间隔），执行高优任务
        if (result.status === 'preempted') {
          log('⚡', '被抢占，立即调度高优任务...');
          continue;
        }
      }
    } catch (err) {
      log('💥', `调度异常: ${err.message}`);
      log('🔍', err.stack?.split('\n').slice(0, 3).join('\n'));
    }

    // 等待下一轮
    log('💤', `等待 ${intervalMs / 1000}s...`);
    await sleep(intervalMs, signal);
  }

  log('👋', 'bm-dispatch 已退出');
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

// ── CLI 入口 ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');

  if (once) {
    let result = await dispatchOnce({ dryRun });
    // 被抢占时继续执行高优任务（--once 也要处理抢占链）
    while (result?.status === 'preempted') {
      log('⚡', '被抢占，继续执行高优任务...');
      result = await dispatchOnce({ dryRun });
    }
    // 高优任务完成后，自动恢复暂停的任务（drain 模式：持续执行直到无任务）
    if (result && result.status !== 'skipped') {
      let next = await dispatchOnce({ dryRun });
      while (next && next.status !== 'skipped') {
        log('🔄', `继续执行: ${next.status} — ${(next.summary || '').slice(0, 60)}`);
        if (next.status === 'preempted') {
          next = await dispatchOnce({ dryRun });
          continue;
        }
        next = await dispatchOnce({ dryRun });
      }
    }
    if (result) {
      log('🏁', `单轮完成: ${result.status}`);
    }
    process.exit(0);
  }

  // 持续循环模式
  const ac = new AbortController();
  process.on('SIGINT', () => { log('🛑', 'SIGINT'); ac.abort(); });
  process.on('SIGTERM', () => { log('🛑', 'SIGTERM'); ac.abort(); });

  await dispatch({ dryRun, signal: ac.signal });
}

// 如果直接运行（非 import）
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(err => {
    log('💥', `致命错误: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
}
