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

  // 1. 直接解析整个输出
  const direct = tryParse(raw.trim());
  if (direct) return { files: [], ...direct };

  // 2. 从 markdown code block 中提取
  const codeBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let cbMatch;
  while ((cbMatch = codeBlockRe.exec(raw)) !== null) {
    const parsed = tryParse(cbMatch[1].trim());
    if (parsed) return { files: [], ...parsed };
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
    if (parsed) return { files: [], ...parsed };
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
  const sessionName = `dispatch-${dispatchId}`;

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

**写结果文件前，先用 session_status 工具查看当前 token 用量，把 tokens_in 填入结果 JSON 的 tokens 字段。**

成功：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"done","summary":"一句话描述你做了什么","files":["产出文件路径"],"tokens":12345}
RESULT_EOF
\`\`\`

失败：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"error","message":"错误描述","tokens":12345}
RESULT_EOF
\`\`\`

阻塞（需要人工介入）：
\`\`\`bash
cat > ${resultFile} << 'RESULT_EOF'
{"status":"blocked","reason":"阻塞原因","tokens":12345}
RESULT_EOF
\`\`\`

⚠️ 写结果文件是你的最后一步操作。`;

  log('🤖', `触发 hooks/agent, 结果文件: ${resultFile}`);

  const res = await fetch(`http://localhost:${port}/hooks/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hooksToken}`,
    },
    body: JSON.stringify({
      message: finalPrompt,
      name: sessionName,
      deliver: true,
      timeoutSeconds: Math.floor(LLM_TIMEOUT_MS / 1000),
    }),
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

// ── 单轮调度 ─────────────────────────────────────────────────────

/**
 * 执行一轮调度：取最高优先级任务 → 规划 → 逐步执行 → 更新结果。
 */
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
  let planText = fv(fields, '任务进展');
  const errorCount = parseInt(fv(fields, '错误次数') || '0', 10);

  log('🎯', `调度任务: ${priority} ${taskName}`);
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
    // 从已有规划中解析子任务
    subtasks = parseSubtasks(planText).filter(s => !s.startsWith('✅'));
  }

  // ── 第二步：执行 ───────────────────────────────────────────────
  let result;
  if (subtasks.length > 0) {
    result = await executeWithSubtasks(task, subtasks, planText, cfg);
  } else {
    result = await executeSingle(task, cfg);
  }

  // 写入 Token 开销（从结果 JSON 的 tokens 字段累加）
  try {
    const totalTokens = result.totalTokens || result.tokens || 0;
    if (totalTokens > 0) {
      await updateField(cfg, recordId, 'Token 开销', totalTokens);
    }
  } catch {}

  return result;
}

/**
 * 逐步执行子任务，每步代码自动更新进度。
 */
async function executeWithSubtasks(task, subtasks, planText, cfg) {
  const recordId = task.record_id;
  const allSubtasks = [...subtasks];
  const completedResults = [];

  for (let i = 0; i < allSubtasks.length; i++) {
    const subtaskName = allSubtasks[i];
    const progressLine = allSubtasks.map((s, j) => {
      if (j < i) return `✅${s}`;
      if (j === i) return `📍${s}`;
      return `○${s}`;
    }).join(' → ');

    // 代码写表：任务进展（合并进度信息）
    const progressText = `${planText.split('\n')[0]}\n📍 ${subtaskName} (${i + 1}/${allSubtasks.length})\n${progressLine}`;
    await updateField(cfg, recordId, '任务进展', progressText);
    log('📍', `子任务 ${i + 1}/${allSubtasks.length}: ${subtaskName}`);

    // 构建子任务 prompt（含前序结果）
    const prompt = await buildPrompt(task, subtaskName, cfg);
    const contextPrompt = completedResults.length > 0
      ? `\n\n## 前序子任务结果\n${completedResults.map(r => `✅ ${r.name}: ${r.summary}`).join('\n')}\n\n${prompt}`
      : prompt;

    // 执行
    let rawOutput;
    try {
      rawOutput = await callLLM(contextPrompt);
    } catch (err) {
      const blocked = await incrementErrorCount(cfg, recordId, `子任务 ${subtaskName} 失败: ${err.message}`);
      return { taskId: recordId, status: blocked ? 'blocked' : 'error', summary: err.message };
    }

    // 解析结果
    const result = extractResultJSON(rawOutput);

    if (result.status === 'error') {
      const blocked = await incrementErrorCount(cfg, recordId, `子任务 ${subtaskName}: ${result.message || result.summary}`);
      if (blocked) return { taskId: recordId, status: 'blocked', summary: result.message };
      // 非 block 的错误，跳过这个子任务继续
    }

    if (result.status === 'blocked') {
      await updateField(cfg, recordId, '状态', '🔒阻塞');
      await updateField(cfg, recordId, '任务进展', `🔒 ${subtaskName} 阻塞: ${result.reason || ''}`);
      return { taskId: recordId, status: 'blocked', summary: result.reason };
    }

    // 子任务完成
    completedResults.push({ name: subtaskName, summary: result.summary || 'done', files: result.files || [], tokens: result.tokens || 0 });
    log('✅', `子任务完成: ${subtaskName} — ${(result.summary || '').slice(0, 60)}`);
  }

  // 全部子任务完成
  const finalProgress = allSubtasks.map(s => `✅${s}`).join(' → ');
  const finalSummary = completedResults.map(r => r.summary).join('; ').slice(0, 200);

  await updateField(cfg, recordId, '任务进展', `✅ 全部完成\n${finalProgress}`);
  await markDone(cfg, recordId, finalSummary);
  log('🎉', `任务完成: ${allSubtasks.length} 个子任务全部完成`);

  const totalTokens = completedResults.reduce((sum, r) => sum + (r.tokens || 0), 0);
  return { taskId: recordId, status: 'done', summary: finalSummary, totalTokens };
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
        // v2: dispatched 状态表示已派发，sub-agent 正在执行，等待间隔后再检查
        // 不再立即检查下一个（避免重复派发同一任务）
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
    const result = await dispatchOnce({ dryRun });
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
