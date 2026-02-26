# base-memory

飞书多维表格驱动的 AI Agent 任务管理系统。代码驱动调度，LLM 只负责执行。

## 特性

- 🧠 多维表格作为持久外脑（任务表 + 执行日志表 + 记忆库）
- 🤖 代码驱动调度 — LLM 不碰表，只返回结果 JSON，代码全自动更新状态
- 📋 Manus 上下文工程方法论内置（上下文卸载、注意力刷新、错误协议）
- 🔄 自动规划 + 子任务拆分 + 逐步执行
- ⚡ 优先级抢占 — 高优任务自动中断低优任务，完成后自动恢复
- 🔁 断点恢复 — 中断/重启后从上次进度继续
- 🧭 智能重规划 — 连续失败自动触发 replan，保留已完成成果
- 🔒 并发锁 — 防止多个调度实例冲突
- 💰 Token 追踪 — 自动统计每个任务的 token 消耗
- 📦 OpenClaw Skill 兼容，开箱即用

## 快速开始

```bash
# 1. clone 仓库
git clone <repo-url> && cd base-memory

# 2. 配置飞书凭证
export FEISHU_APP_ID="your_app_id"
export FEISHU_APP_SECRET="your_app_secret"

# 3. 一键建表
bm setup

# 4. 开始使用
bm task add "我的第一个任务" -p 普通 -i "测试任务管理"
bm task next
```

> `bm setup` 会在飞书多维表格中自动创建任务表、执行日志表、记忆库三张表，并生成 `base_config.json` 配置文件。

## 集成到你的 Agent

> base-memory **不是按需触发的 skill**，而是 agent 的**默认工作行为**。
> 安装后，agent 收到任何任务都应走 bm 工作流——不需要关键词触发，是你应该如何工作的方法论。

### 自动注入（推荐）

```bash
bm setup --inject-agents
```

将精简版任务执行规范追加到 `AGENTS.md`（或 `$OPENCLAW_WORKSPACE/AGENTS.md`），让 agent 从第一条任务起就走 bm 流程。如果已集成会自动跳过。

### 手动集成

把 `references/workflow-rules.md` 的核心规则复制到你的 `AGENTS.md` 或系统提示词中。

### 核心规则（5 条）

1. **入队先于执行** — 收到任务先 `bm task add` 入队，不直接执行
2. **计划先于行动** — 执行前先 `bm log add plan` 写计划（不可跳过）
3. **立刻卸载上下文** — 工具调用结果立刻写入日志表（`bm log add finding/error/decision`），不留在上下文
4. **阶段转换时检查** — 每个阶段完成后 `bm task phase` 更新 + `bm task next` 中断检查
5. **完成后回复用户** — `bm task done` 后附上结论回复触发消息

> 完整规范见 [references/workflow-rules.md](references/workflow-rules.md)

## 命令速查

```
bm task add/ls/done/phase/show/search/block/interrupt/resume/next
bm subtask done/phase
bm log add/ls/search
bm mem add/search
bm dispatch [--once] [--dry-run]     # 代码驱动调度
bm setup                             # 一键建表
```

### 任务管理

```bash
bm task add "任务名" [-p 紧急|重要|普通] [-i "原始指令"]
bm task add "子任务" --parent <父ID>  # 内联子任务（不建新行）
bm task done <ID> [-s "结果摘要"]
bm task phase <ID> "阶段2-实现"
bm task show <ID>                    # 重读目标（注意力刷新）
bm task next                         # 调度器：现在该做什么？
bm task resume                       # 5 问重启检查
bm task ls [--all]
bm task interrupt <ID> -m "断点"     # 手动中断（自动中断由 dispatch 处理）
```

### 子任务（内联在父任务行）

```bash
bm task add "子任务A" --parent <父ID>
bm subtask phase <父ID> "子任务A" "阶段描述"
bm subtask done <父ID> "子任务A" -s "完成摘要"
# 最后一个子任务完成 → 父任务自动标完成
```

### 执行日志（上下文卸载）

```bash
bm log add <ID> finding "发现：API 返回格式是..."
bm log add <ID> decision "决策：用 A 不用 B，理由..."
bm log add <ID> error "错误：... 原因：... 方案：..."
bm log add <ID> milestone "阶段1完成：..."
bm log add <ID> resource "URL 或文件路径"
bm log ls <ID> [--type finding]
```

### 记忆库（长期记忆）

```bash
bm mem add "飞书 API 限制" "image API 不支持 interactive 消息类型" -t 教训
bm mem search "飞书"
```

## 架构

```
base-memory/
├── scripts/
│   ├── bm                           # CLI 主入口（Python）
│   ├── bm-dispatch.mjs              # 代码驱动调度器（核心）
│   ├── bm-dispatch-startup.mjs      # 网关重启自动恢复
│   ├── bm-dispatch-trigger.sh       # 触发脚本（供 Python 调用）
│   ├── bt_setup.py                  # 一键建表脚本
│   ├── test-dispatch-replan.mjs     # 单元测试（57 tests）
│   └── test-dispatch-e2e.mjs        # 端到端测试（9 tests）
├── references/
│   ├── workflow-rules.md            # 工作流规则（Manus 方法论）
│   ├── lessons-learned.md           # 经验教训
│   └── prompt-templates.md          # Prompt 模板
├── SKILL.md                         # OpenClaw Skill 规范
└── README.md
```

## 代码驱动调度（bm-dispatch）

独立 Node 进程，完整的任务生命周期自动管理。**代码管状态，LLM 管执行。**

### 运行模式

```bash
node scripts/bm-dispatch.mjs              # 持续循环（生产模式）
node scripts/bm-dispatch.mjs --once       # 单轮执行（心跳/测试用）
node scripts/bm-dispatch.mjs --dry-run    # 只打印 prompt，不调 LLM
```

### 调度流程

```
fetchNextTask          # 按优先级+状态排序，取最高优先级任务
  ↓
markInProgress         # 状态 → 🔄 进行中
  ↓
planTask               # LLM 分析任务 → 自动拆子任务（首次执行时）
  ↓
executeWithSubtasks    # 逐步执行子任务，代码实时更新进度
  ├─ 每步完成 → checkPreemption（中断检查）
  ├─ 连续失败 ≥3 → replanTask（智能重规划）
  └─ 全部完成 → markDone
  ↓
unloadFindings         # LLM 总结关键发现 → 代码写入日志表
  ↓
resetDispatchSession   # 清理 session，为下一个任务准备干净上下文
```

### 核心机制

#### 🔄 Session 复用

所有子任务共享同一个 OpenClaw session（`hook:dispatch`），上下文在子任务间自然保留。相比每个子任务独立 session，token 消耗降低数十倍。

#### ⚡ 优先级抢占 + 自动恢复

执行子任务过程中，每完成一个会检查是否有更高优先级任务插入：

```
任务A（普通）执行中 → 任务B（紧急）插入
  → A 暂停（⏸️ 保存断点：✅子1 → ✅子2 → ○子3）
  → B 开始执行
  → B 完成
  → A 自动恢复，从子3 继续执行
```

暂停的任务在调度排序中优先于待开始的任务，确保不会被遗忘。

#### 🔁 断点恢复

任务进展字段记录了每个子任务的完成状态（`✅A → 📍B → ○C`）。中断后恢复时，`parseCompletedSubtasks()` 自动识别已完成子任务并跳过，从上次断点继续。

#### 🧭 智能重规划（Replan）

当同一子任务连续失败 ≥3 次，或 LLM 显式返回 `needReplan: true` 时，自动触发重规划：

- 保留已完成的子任务成果
- 只重新规划失败及后续的子任务
- 每个任务最多 replan 1 次，避免无限循环
- 达上限自动阻塞 + 飞书通知

#### 📤 上下文卸载

任务完成后，`unloadFindings()` 让 LLM 总结关键发现（findings / decisions / resources），代码自动写入日志表。确保即使 session 被清理，有价值的发现仍持久化在 Bitable 中。

#### 🔒 并发锁

文件锁 `/tmp/bm-dispatch.lock`，防止多个 dispatch 实例同时运行：

- 锁文件记录 `{pid, startTime, taskId}`
- 15 分钟过期自动清理
- 进程死亡自动释放（通过 `process.kill(pid, 0)` 检测）
- `--once` 模式（心跳触发）自动跳过已锁状态

#### 💰 Token 追踪

基于 session token diff（T1 - T0）自动计算每个任务的 token 消耗，写入任务表 `Token 开销` 字段。

### 结果文件通信

LLM 通过写文件返回结果（不调 bm 命令），dispatch 轮询文件获取：

```json
// 成功
{"status": "done", "summary": "一句话摘要", "files": ["产出路径"]}

// 失败
{"status": "error", "message": "错误描述"}

// 阻塞（需人工介入）
{"status": "blocked", "reason": "阻塞原因"}

// 请求重规划
{"status": "error", "message": "...", "needReplan": true}
```

## 内置安全机制

| 机制 | 说明 |
|------|------|
| 📏 内容截断 | 日志超 500 字自动截断，提醒用 `--file` 附件 |
| 🔄 注意力刷新 | 每 10 条日志提醒 `bm task show`，防止跑偏 |
| 📋 Plan 必须先写 | 没写计划就记日志会警告 |
| 🚫 错误协议 | 追踪错误次数，必须改变方法才能重试（第 5 次自动阻塞 + 飞书通知） |
| ✅ 完成检查 | `bm task done` 检查 plan + milestone 是否齐全 |
| 🔒 并发锁 | 文件锁防多实例，15min 自动过期 |
| ⚡ 优先级抢占 | 高优任务自动中断低优任务 |

## 测试

```bash
# 单元测试（57 tests）— 纯函数测试，不依赖外部服务
node scripts/test-dispatch-replan.mjs

# 端到端测试（9 tests）— 真实 Bitable 生命周期
node scripts/test-dispatch-e2e.mjs
```

测试覆盖：子任务解析、断点恢复、结果提取、replan 触发/执行、规划解析、上下文卸载、session 复用、并发锁、抢占恢复。

## 配置

`bm setup` 生成 `base_config.json`：

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

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 ID | — |
| `FEISHU_APP_SECRET` | 飞书应用 Secret | — |
| `BT_OWNER_OPEN_ID` | Owner 的飞书 open_id（通知） | — |
| `BT_MAX_ERROR_RETRIES` | 最大错误重试次数 | 5 |
| `BT_POLL_INTERVAL_MS` | 主循环间隔 | 30000 |
| `BT_LLM_TIMEOUT_MS` | LLM 单次超时 | 600000 |
| `BT_LOCK_STALE_MS` | 锁过期时间 | 900000 |
| `OPENCLAW_PORT` | OpenClaw 端口 | 18789 |
| `OPENCLAW_HOOKS_TOKEN` | hooks 认证 token | 从 config 读取 |

## 依赖

- **运行时**：Node.js ≥ 18、Python ≥ 3.8
- **服务**：飞书开放平台（Bitable API）、OpenClaw（hooks/agent）
- **飞书权限**：`bitable:app`（多维表格读写）、`im:message`（通知，可选）

## 文档

- [工作流规则](references/workflow-rules.md) — 完整的 Manus 方法论
- [经验教训](references/lessons-learned.md) — Bitable API、消息发送等实战经验
- [Prompt 模板](references/prompt-templates.md) — dispatch 的 prompt 构建和结果格式
- [Skill 规范](SKILL.md) — OpenClaw Agent Skill 接入指南

## 灵感来源

上下文管理策略参考 [Manus](https://manus.im) 的上下文工程方法：`task_plan.md` → 任务表，`findings.md` + `progress.md` → 执行日志表。记忆库是 Manus 没有的扩展。调度架构参考 Claude Code 的主代理/子代理分层模式，用代码外循环保证确定性，session 复用保留上下文。

## License

MIT
