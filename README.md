# base-memory

飞书多维表格驱动的 AI Agent 任务管理系统。代码驱动调度，LLM 只负责执行。

## 特性

- 🧠 多维表格作为持久外脑（任务表 + 执行日志表 + 记忆库）
- 🤖 代码驱动调度 — LLM 不碰表，只返回结果 JSON
- 📋 Manus 上下文工程方法论内置
- 🔄 三个自动触发入口（done / 紧急 / 重启）
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

## 命令速查

```
bm task add/ls/done/phase/show/search/block/interrupt/resume
bm subtask done/phase
bm log add/ls/search
bm mem add/search
bm dispatch                          # 代码驱动调度
bm setup                             # 一键建表
```

### 任务管理

```bash
bm task add "任务名" [-p 紧急|重要|普通] [-i "原始指令"]
bm task done <ID> [-s "结果摘要"]
bm task phase <ID> "阶段2-实现"
bm task show <ID>                    # 重读目标（注意力刷新）
bm task next                         # 调度器：现在该做什么？
bm task resume                       # 5 问重启检查
bm task ls [--all]
```

### 执行日志（上下文卸载）

```bash
bm log add <ID> finding "发现：API 返回格式是..."
bm log add <ID> decision "决策：用 A 不用 B，理由..."
bm log add <ID> error "错误：... 原因：... 方案：..."
bm log add <ID> milestone "阶段1完成：..."
bm log ls <ID> [--type finding]
```

### 记忆库（长期记忆）

```bash
bm mem add "飞书 API 限制" "image API 不支持 interactive 消息类型" -t 教训
bm mem search "飞书"
```

### 子任务（内联在父任务行）

```bash
bm task add "子任务A" --parent <父ID>
bm subtask done <父ID> "子任务A" -s "完成摘要"
# 最后一个子任务完成 → 父任务自动标完成
```

## 架构

```
base-memory/
├── scripts/
│   ├── bm                        # CLI 主入口（Python）
│   ├── bm-dispatch.mjs           # 代码驱动调度器
│   ├── bm-dispatch-startup.mjs   # 网关重启自动恢复
│   └── bt_setup.py               # 一键建表脚本
├── references/
│   ├── workflow-rules.md          # 工作流规则
│   ├── lessons-learned.md         # 经验教训
│   └── prompt-templates.md        # Prompt 模板
├── SKILL.md                       # OpenClaw Skill 规范
└── README.md
```

## 代码驱动调度（bm-dispatch）

独立 Node 进程，循环查 Base 任务表 → 拼 prompt → 调用 LLM → 解析结果 JSON → 更新 Base。LLM 只需专注执行并返回结构化结果。

```bash
node scripts/bm-dispatch.mjs              # 持续循环（生产模式）
node scripts/bm-dispatch.mjs --once       # 单轮执行（测试用）
node scripts/bm-dispatch-startup.mjs      # 网关启动时自动恢复
```

## 内置安全机制

| 机制 | 说明 |
|------|------|
| 📏 内容截断 | 日志超 500 字自动截断，提醒用 `--file` 附件 |
| 🔄 注意力刷新 | 每 10 条日志提醒 `bm task show`，防止跑偏 |
| 📋 Plan 必须先写 | 没写计划就记日志会警告 |
| 🚫 错误协议 | 追踪错误次数，必须改变方法才能重试（第 5 次自动阻塞 + 通知 owner） |

## 配置

`bm setup` 生成 `base_config.json`：

```json
{
  "app_token": "...",
  "tables": {
    "tasks":  { "id": "tblXXX", "fields": { ... } },
    "logs":   { "id": "tblXXX", "fields": { ... } },
    "memory": { "id": "tblXXX", "fields": { ... } }
  }
}
```

环境变量：

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 飞书应用 Secret |
| `BT_OWNER_OPEN_ID` | Owner 的飞书 open_id（用于通知） |
| `BT_MAX_ERROR_RETRIES` | 最大错误重试次数（默认 5） |

## 文档

- [工作流规则](references/workflow-rules.md)
- [经验教训](references/lessons-learned.md)
- [Prompt 模板](references/prompt-templates.md)
- [Skill 规范](SKILL.md)

## 灵感来源

上下文管理策略参考 [Manus](https://manus.im) 的上下文工程方法：`task_plan.md` → 任务表，`findings.md` + `progress.md` → 执行日志表，长期记忆 → 记忆库（Manus 没有的扩展）。

## License

MIT
