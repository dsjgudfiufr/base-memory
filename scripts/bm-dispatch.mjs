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

import { readFileSync, existsSync, unlinkSync } from 'fs';
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
    app_id: acc.appId,
    app_secret: acc.appSecret,
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
      return (parts || '').split('→').map(n => n.trim().replace(/^✅/, '').trim()).filter(Boolean);
    }
  }
  return [];
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

async function fetchNextTask(cfg) {
  const { app_token } = cfg;
  const tableId = cfg.tables.tasks.id;

  const candidates = await searchRecords(app_token, tableId, {
    filter: {
      conjunction: 'or',
      conditions: [
        { field_name: '状态', operator: 'is', value: ['🔄 进行中'] },
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


export async function dispatchOnce(opts = {}) {
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
  const planText = fv(fields, '任务进展');
  const errorCount = parseInt(fv(fields, '错误次数') || '0', 10);
  const rawInstruction = fv(fields, '原始指令');

  log('🎯', `调度任务: ${priority} ${taskName}`);
  log('📋', `record_id: ${recordId}, 错误次数: ${errorCount}`);

  // 标记进行中
  await markInProgress(cfg, recordId);
  await updateField(cfg, recordId, '任务进展', '🔄 等待执行...');

  // 构建 prompt
  const prompt = await buildPrompt(task, null, cfg);

  // 输出 JSON 供 sessions_spawn 使用
  const result = {
    action: 'spawn',
    recordId,
    taskName,
    priority,
    errorCount,
    rawInstruction,
    planText,
    prompt,
  };

  // 输出到 stdout（供主 session 解析）
  console.log('__DISPATCH_RESULT__' + JSON.stringify(result));
  return result;
}

/**
 * 逐步执行子任务，所有子任务复用同一个 session（省 token）。
 * Token 计算：最后一个子任务报告的 tokens 即为整个 session 的累计消耗。
 */


// ── CLI 入口 ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  try {
    const result = await dispatchOnce({ dryRun });
    if (result) {
      log('🏁', `派发完成: ${result.taskName}`);
    }
  } catch (err) {
    log('💥', `致命错误: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
