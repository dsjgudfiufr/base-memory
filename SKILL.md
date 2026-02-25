---
name: base-memory
description: Use Feishu Base (Bitable) as an AI agent's external brain — task management, execution logs, long-term memory, and code-driven dispatch. Activate when managing tasks, logging findings, storing memories, or running automated task scheduling.
---

# Base Memory — 飞书多维表格作为 AI Agent 外脑

> 上下文窗口 = RAM（易失、有限）。Base = Disk（持久、无限）。

## Setup

First-time setup: run `bm setup` to create tables and generate config.

```bash
# Set credentials (or pass via config)
export FEISHU_APP_ID="YOUR_APP_ID"
export FEISHU_APP_SECRET="YOUR_APP_SECRET"

# Initialize: creates 3 tables in a new or existing Base
python3 scripts/bm setup [--app-token YOUR_APP_TOKEN]
# → Generates base_config.json with table IDs and field IDs
# → Creates: 任务表 / 执行日志表 / 记忆库
```

## Architecture: Three Tables

| Table | Purpose | Analogy |
|-------|---------|---------|
| **任务表** (tasks) | Task status snapshots — goal, phase, progress | `task_plan.md` |
| **执行日志表** (logs) | Process notes — findings, decisions, errors | `findings.md` + `progress.md` |
| **记忆库** (memory) | Long-term memory — cross-task lessons | Persistent knowledge base |

## Core Commands (`bm`)

### Task Management

```bash
bm task add "Task name" [-p 紧急|重要|普通] [-i "original instruction"]
bm task done <ID> [-s "result summary"]
bm task phase <ID> "阶段2-实现"
bm task show <ID>              # Re-read goal + plan (attention refresh)
bm task ls [--all]             # List active tasks
bm task next                   # Scheduler: what should I do now?
bm task resume                 # 5-question restart check
bm task block <ID> -r "reason"
bm task interrupt <ID> -m "breakpoint description"
bm task search <keyword>
```

### Subtasks (inline, no separate rows)

```bash
bm task add "Subtask A" --parent <PARENT_ID>
bm subtask phase <PARENT_ID> "Subtask A" "Phase description"
bm subtask done <PARENT_ID> "Subtask A" -s "summary"
# Last subtask done → parent auto-completes
```

### Execution Logs (context offloading)

```bash
bm log add <ID> plan "Goal: ... Phases: ... Key questions: ..."
bm log add <ID> finding "Discovery: ..."
bm log add <ID> decision "Decision: A not B, reason: ..."
bm log add <ID> error "Error: ... Cause: ... Fix: ..."
bm log add <ID> resource "URL or file path"
bm log add <ID> milestone "Phase N complete: ..."
bm log add <ID> progress "What was done" --phase "Phase N"
bm log ls <ID> [--type finding] [--last 10]
bm log search <keyword>
```

### Memory (long-term)

```bash
bm mem add "Title" "Content" [-t type]
bm mem ls [--type 教训]
bm mem search <keyword>
```

## 代码驱动调度（bm-dispatch）

独立 Node 进程，**代码管状态，LLM 管执行**。完整的任务生命周期自动管理。

### 运行模式

```bash
node scripts/bm-dispatch.mjs           # 持续循环（生产模式）
node scripts/bm-dispatch.mjs --once    # 单轮执行（心跳/测试用）
node scripts/bm-dispatch.mjs --dry-run # 只打印 prompt，不调 LLM
```

### 调度流程

```
fetchNextTask → markInProgress → planTask → executeWithSubtasks
  → [checkPreemption per subtask] → unloadFindings → resetSession → done
```

### 核心机制

- **Session 复用**：所有子任务共享 `hook:dispatch` session，上下文自然保留，token 消耗降低数十倍
- **自动规划**：`planTask()` 分析任务并自动拆分子任务（首次执行时）
- **优先级抢占**：高优任务自动中断低优 → 保存断点 → 高优完成后自动恢复
- **断点恢复**：从 `任务进展` 字段解析已完成子任务，中断后从断点继续
- **智能重规划**：连续失败 ≥3 次或 LLM 返回 `needReplan:true` → 保留已完成成果，重新规划失败部分
- **上下文卸载**：任务完成后 LLM 总结关键发现 → 代码写入日志表（持久化）
- **Session 清场**：任务间自动清理 session 上下文
- **并发锁**：文件锁防止多实例冲突，15min 过期自动清理
- **Token 追踪**：session token diff 自动计算每任务消耗

### LLM 结果格式

LLM 通过文件返回结果（不调 bm 命令）：

```json
{"status": "done", "summary": "摘要", "files": ["路径"]}
{"status": "error", "message": "错误描述"}
{"status": "blocked", "reason": "阻塞原因"}
{"status": "error", "message": "...", "needReplan": true}
```

### 配置

```bash
BT_POLL_INTERVAL_MS=30000       # 主循环间隔
BT_MAX_ERROR_RETRIES=5          # 最大错误重试
BT_LLM_TIMEOUT_MS=600000        # LLM 超时
BT_LOCK_STALE_MS=900000         # 锁过期时间
BT_OWNER_OPEN_ID=xxx            # 飞书通知接收人
OPENCLAW_PORT=18789              # OpenClaw 端口
OPENCLAW_HOOKS_TOKEN=xxx         # hooks 认证 token
```

## Built-in Safeguards

1. **Content truncation** — `bm log add` auto-truncates at 500 chars, warns to use `--file`
2. **Attention refresh** — Every 10 logs, reminds to `bm task show` (prevents drift)
3. **Plan-first check** — Warns if logging before writing a plan
4. **Error protocol** — Tracks error count; must change approach before retrying; 5 failures → auto-block + Feishu notify
5. **Completion check** — `bm task done` warns if plan or milestone logs are missing
6. **Concurrent lock** — File lock prevents multiple dispatch instances
7. **Priority preemption** — High priority tasks auto-interrupt low priority, with breakpoint save and auto-resume

## Testing

```bash
node scripts/test-dispatch-replan.mjs    # 57 unit tests (pure functions, no external deps)
node scripts/test-dispatch-e2e.mjs       # 9 e2e tests (real Bitable lifecycle)
```

Coverage: subtask parsing, breakpoint resume, result extraction, replan trigger/execution, plan parsing, context unloading, session reuse, concurrent lock, preemption resume.

## Workflow Rules

For the complete task execution methodology, see [references/workflow-rules.md](references/workflow-rules.md):

- **Task reception**: classify message → task or conversation → only tasks go to Base
- **Plan first**: always `bm log add plan` before executing
- **Two-action rule**: every 2 search/browse ops → immediately `bm log add finding`
- **Visual content**: see image/screenshot → immediately textualize to finding log
- **Context offloading**: tool output → log table, not context window
- **Error protocol**: must change approach before retrying; 5 failures → auto-block
- **Attention refresh**: `bm task show` every 10 tool calls or before major decisions
- **Sub-Agent execution**: complex tasks use main+sub-agent pattern for reliability
- **Code-driven dispatch**: bm-dispatch for production-grade task scheduling

## Reference Documents

| Document | Content |
|----------|---------|
| [references/workflow-rules.md](references/workflow-rules.md) | Complete task execution methodology |
| [references/lessons-learned.md](references/lessons-learned.md) | Practical lessons from Base API, messaging, error handling |
| [references/prompt-templates.md](references/prompt-templates.md) | bm-dispatch prompt templates and result JSON format |

## Configuration

`base_config.json` (generated by `bm setup`):

```json
{
  "app_token": "YOUR_APP_TOKEN",
  "tables": {
    "tasks": { "id": "tblXXX", "fields": { "任务名称": "fldXXX", ... } },
    "logs":  { "id": "tblXXX", "fields": { "内容": "fldXXX", ... } },
    "memory": { "id": "tblXXX", "fields": { "标题": "fldXXX", ... } }
  },
  "notify_chat_id": "oc_xxx"
}
```

Credentials: set `FEISHU_APP_ID` + `FEISHU_APP_SECRET` env vars, or pass via config.
