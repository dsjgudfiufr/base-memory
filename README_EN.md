> 🇨🇳 [中文版](README.md)

# base-memory

AI agent task management powered by Feishu (Lark) Bitable. Code drives scheduling; the LLM just executes.

## Features

- 🧠 Bitable as persistent external memory (task table + execution log table + memory store)
- 🤖 Code-driven scheduling — the LLM never touches tables directly; it returns result JSON and code handles all state updates
- 📋 Built-in Manus context engineering methodology (context offloading, attention refresh, error protocol)
- 🔄 Auto-planning + subtask decomposition + step-by-step execution
- ⚡ Priority preemption — high-priority tasks automatically interrupt lower ones and resume after
- 🔁 Checkpoint recovery — pick up right where you left off after interrupts or restarts
- 🧭 Smart replanning — consecutive failures trigger automatic replan while preserving completed work
- 🔒 Concurrency lock — prevents multiple dispatch instances from conflicting
- 💰 Token tracking — automatic per-task token consumption stats
- 📦 OpenClaw Skill compatible, works out of the box

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url> && cd base-memory

# 2. Set Feishu credentials
export FEISHU_APP_ID="your_app_id"
export FEISHU_APP_SECRET="your_app_secret"

# 3. One-command table setup
bm setup

# 4. Start using it
bm task add "My first task" -p 普通 -i "Test task management"   # 普通=normal
bm task next
```

> `bm setup` automatically creates three tables in a Feishu Bitable — tasks, execution logs, and memory — and generates a `base_config.json` config file.

## Integrating with Your Agent

> base-memory is **not an on-demand skill** — it's the agent's **default operating behavior**.
> Once installed, every task the agent receives should go through the bm workflow. No keyword triggers needed; this is how your agent should work.

### Auto-Injection (Recommended)

```bash
bm setup --inject-agents
```

Appends a condensed task execution spec to `AGENTS.md` (or `$OPENCLAW_WORKSPACE/AGENTS.md`), so the agent follows the bm workflow from the very first task. Skips automatically if already integrated.

### Manual Integration

Copy the core rules from `references/workflow-rules.md` into your `AGENTS.md` or system prompt.

### Core Rules (5)

1. **Queue before execute** — Always `bm task add` first; never execute directly
2. **Plan before act** — Write a plan with `bm log add plan` before doing anything (non-skippable)
3. **Offload context immediately** — Write tool results to the log table right away (`bm log add finding/error/decision`); don't keep them in context
4. **Check at phase transitions** — After each phase: `bm task phase` to update + `bm task next` for interrupt check
5. **Reply after completion** — After `bm task done`, reply to the triggering message with your conclusion

> Full spec: [references/workflow-rules.md](references/workflow-rules.md)

## Command Reference

```
bm task add/ls/done/phase/show/search/block/interrupt/resume/next
bm subtask done/phase
bm log add/ls/search
bm mem add/search
bm dispatch [--once] [--dry-run]     # Code-driven dispatch
bm setup                             # One-command table setup
```

### Task Management

```bash
# Priorities: 紧急=urgent | 重要=important | 普通=normal
bm task add "Task name" [-p 紧急|重要|普通] [-i "original instruction"]
bm task add "Subtask" --parent <parentID>  # Inline subtask (no new row)
bm task done <ID> [-s "result summary"]
bm task phase <ID> "Phase 2 - Implementation"
bm task show <ID>                    # Re-read goal (attention refresh)
bm task next                         # Scheduler: what should I do now?
bm task resume                       # 5-question restart check
bm task ls [--all]
bm task interrupt <ID> -m "checkpoint note"  # Manual interrupt (auto handled by dispatch)
```

### Subtasks (Inline on Parent Row)

```bash
bm task add "Subtask A" --parent <parentID>
bm subtask phase <parentID> "Subtask A" "phase description"
bm subtask done <parentID> "Subtask A" -s "completion summary"
# When the last subtask completes → parent auto-completes
```

### Execution Logs (Context Offloading)

```bash
bm log add <ID> finding "Found: API response format is..."
bm log add <ID> decision "Decision: use A over B because..."
bm log add <ID> error "Error: ... Cause: ... Fix: ..."
bm log add <ID> milestone "Phase 1 complete: ..."
bm log add <ID> resource "URL or file path"
bm log ls <ID> [--type finding]
```

### Memory Store (Long-Term Memory)

```bash
bm mem add "Feishu API limits" "image API doesn't support interactive msg type" -t 教训  # 教训=lesson
bm mem search "Feishu"
```

## Architecture

```
base-memory/
├── scripts/
│   ├── bm                           # CLI entry point (Python)
│   ├── bm-dispatch.mjs              # Code-driven dispatcher (core)
│   ├── bm-dispatch-startup.mjs      # Auto-recovery on gateway restart
│   ├── bm-dispatch-trigger.sh       # Trigger script (called by Python)
│   ├── bt_setup.py                  # One-command table setup
│   ├── test-dispatch-replan.mjs     # Unit tests (57 tests)
│   └── test-dispatch-e2e.mjs        # End-to-end tests (9 tests)
├── references/
│   ├── workflow-rules.md            # Workflow rules (Manus methodology)
│   ├── lessons-learned.md           # Lessons learned
│   └── prompt-templates.md          # Prompt templates
├── SKILL.md                         # OpenClaw Skill spec
└── README.md
```

## Code-Driven Dispatch (bm-dispatch)

A standalone Node process that manages the full task lifecycle automatically. **Code owns state; the LLM owns execution.**

### Run Modes

```bash
node scripts/bm-dispatch.mjs              # Continuous loop (production)
node scripts/bm-dispatch.mjs --once       # Single round (heartbeat/testing)
node scripts/bm-dispatch.mjs --dry-run    # Print prompt only, don't call LLM
```

### Dispatch Flow

```
fetchNextTask          # Sort by priority + status, pick highest priority
  ↓
markInProgress         # Status → 🔄 In Progress
  ↓
planTask               # LLM analyzes task → auto-decompose subtasks (first run)
  ↓
executeWithSubtasks    # Execute subtasks step by step, code updates progress in real time
  ├─ After each step → checkPreemption (interrupt check)
  ├─ ≥3 consecutive failures → replanTask (smart replan)
  └─ All done → markDone
  ↓
unloadFindings         # LLM summarizes key findings → code writes to log table
  ↓
resetDispatchSession   # Clean up session, prepare fresh context for next task
```

### Core Mechanisms

#### 🔄 Session Reuse

All subtasks share a single OpenClaw session (`hook:dispatch`), so context flows naturally between them. Compared to isolated sessions per subtask, this reduces token consumption by an order of magnitude.

#### ⚡ Priority Preemption + Auto-Recovery

After each subtask completes, the dispatcher checks whether a higher-priority task has arrived:

```
Task A (normal) running → Task B (urgent) arrives
  → A paused (⏸️ checkpoint saved: ✅sub1 → ✅sub2 → ○sub3)
  → B starts executing
  → B completes
  → A auto-resumes from sub3
```

Paused tasks rank above pending tasks in scheduling, so they're never forgotten.

#### 🔁 Checkpoint Recovery

The task progress field tracks each subtask's completion status (`✅A → 📍B → ○C`). On resume, `parseCompletedSubtasks()` automatically identifies completed subtasks, skips them, and continues from the last checkpoint.

#### 🧭 Smart Replanning

When the same subtask fails ≥3 consecutive times, or the LLM explicitly returns `needReplan: true`, an automatic replan is triggered:

- Preserves completed subtask results
- Only replans the failed subtask and subsequent ones
- Max 1 replan per task to prevent infinite loops
- Hits the limit → auto-blocks + sends a Feishu notification

#### 📤 Context Offloading

After task completion, `unloadFindings()` asks the LLM to summarize key findings (findings / decisions / resources), then code writes them to the log table. This ensures valuable discoveries persist in Bitable even after the session is cleaned up.

#### 🔒 Concurrency Lock

File lock at `/tmp/bm-dispatch.lock` prevents multiple dispatch instances from running simultaneously:

- Lock file stores `{pid, startTime, taskId}`
- Auto-expires after 15 minutes
- Auto-releases on process death (detected via `process.kill(pid, 0)`)
- `--once` mode (heartbeat-triggered) automatically skips if locked

#### 💰 Token Tracking

Calculates per-task token consumption via session token diff (T1 - T0) and writes it to the task table's `Token 开销` field.

### Result File Communication

The LLM returns results by writing files (not by calling bm commands); dispatch polls for the file:

```json
// Success
{"status": "done", "summary": "One-line summary", "files": ["output paths"]}

// Failure
{"status": "error", "message": "Error description"}

// Blocked (needs human intervention)
{"status": "blocked", "reason": "Reason for blocking"}

// Request replan
{"status": "error", "message": "...", "needReplan": true}
```

## Built-in Safety Mechanisms

| Mechanism | Description |
|-----------|-------------|
| 📏 Content truncation | Logs over 500 chars are auto-truncated with a reminder to use `--file` attachments |
| 🔄 Attention refresh | Every 10 log entries triggers a `bm task show` reminder to prevent drift |
| 📋 Plan-first enforcement | Logging without a plan triggers a warning |
| 🚫 Error protocol | Tracks error count; you must change your approach before retrying (auto-blocks + Feishu notification on the 5th failure) |
| ✅ Completion check | `bm task done` verifies that plan + milestone logs exist |
| 🔒 Concurrency lock | File lock prevents multi-instance conflicts, 15min auto-expiry |
| ⚡ Priority preemption | High-priority tasks automatically interrupt lower ones |

## Testing

```bash
# Unit tests (57 tests) — pure function tests, no external dependencies
node scripts/test-dispatch-replan.mjs

# End-to-end tests (9 tests) — real Bitable lifecycle
node scripts/test-dispatch-e2e.mjs
```

Coverage includes: subtask parsing, checkpoint recovery, result extraction, replan trigger/execution, plan parsing, context offloading, session reuse, concurrency lock, preemption recovery.

## Configuration

`bm setup` generates `base_config.json`:

```json
{
  "app_token": "...",
  "tables": {
    "tasks":  { "id": "tblXXX", "fields": { ... } },
    "logs":   { "id": "tblXXX", "fields": { ... } },
    "memory": { "id": "tblXXX", "fields": { ... } }
  },
  "notify_chat_id": "oc_xxx"
}
```

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `FEISHU_APP_ID` | Feishu App ID | — |
| `FEISHU_APP_SECRET` | Feishu App Secret | — |
| `BT_OWNER_OPEN_ID` | Owner's Feishu open_id (for notifications) | — |
| `BT_MAX_ERROR_RETRIES` | Max error retries | 5 |
| `BT_POLL_INTERVAL_MS` | Main loop interval | 30000 |
| `BT_LLM_TIMEOUT_MS` | LLM single-call timeout | 600000 |
| `BT_LOCK_STALE_MS` | Lock expiry time | 900000 |
| `OPENCLAW_PORT` | OpenClaw port | 18789 |
| `OPENCLAW_HOOKS_TOKEN` | Hooks auth token | Read from config |

## Dependencies

- **Runtime**: Node.js ≥ 18, Python ≥ 3.8
- **Services**: Feishu Open Platform (Bitable API), OpenClaw (hooks/agent)
- **Feishu permissions**: `bitable:app` (Bitable read/write), `im:message` (notifications, optional)

## Documentation

- [Workflow Rules](references/workflow-rules.md) — Full Manus methodology
- [Lessons Learned](references/lessons-learned.md) — Battle-tested tips on Bitable API, messaging, etc.
- [Prompt Templates](references/prompt-templates.md) — Dispatch prompt construction and result formats
- [Skill Spec](SKILL.md) — OpenClaw Agent Skill integration guide

## Inspiration

The context management strategy draws from [Manus](https://manus.im)'s context engineering approach: `task_plan.md` → task table, `findings.md` + `progress.md` → execution log table. The memory store is an extension Manus doesn't have. The dispatch architecture is inspired by Claude Code's main-agent/sub-agent layered model, using a code outer loop for determinism and session reuse to preserve context.

## License

MIT
