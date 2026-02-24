# 🧠 Bitable Memory — 飞书多维表格作为 AI Agent 外脑

> 上下文窗口 = RAM（易失、有限）。Bitable = Disk（持久、无限）。

把飞书多维表格变成 AI Agent 的持久化大脑：**任务管理 + 执行日志 + 长期记忆**，一个 CLI 搞定。

## 为什么需要？

AI Agent 的上下文窗口会丢失。每次新 session，之前的发现、决策、教训全部清零。Bitable Memory 解决这个问题：

- **任务表** — 记录目标、阶段、进度（像 `task_plan.md`）
- **执行日志表** — 记录发现、决策、错误（像 `findings.md` + `progress.md`）
- **记忆库** — 跨任务的长期经验沉淀

## 快速开始

```bash
# 1. 设置飞书凭证
export FEISHU_APP_ID="your_app_id"
export FEISHU_APP_SECRET="your_app_secret"

# 2. 初始化（一键建表 + 生成配置）
python3 scripts/bt setup

# 3. 创建 symlink
ln -sf $(pwd)/scripts/bt /usr/local/bin/bt

# 4. 开始使用
bt task add "我的第一个任务" -p 普通 -i "测试任务管理"
bt task next
```

## 核心命令

### 任务管理
```bash
bt task add "任务名" [-p 紧急|重要|普通] [-i "原始指令"]
bt task done <ID> [-s "结果摘要"]
bt task phase <ID> "阶段2-实现"
bt task show <ID>              # 重读目标（注意力刷新）
bt task next                   # 调度器：现在该做什么？
bt task resume                 # 5问重启检查
bt task ls [--all]
```

### 执行日志（上下文卸载）
```bash
bt log add <ID> finding "发现：API 返回格式是..."
bt log add <ID> decision "决策：用 A 不用 B，理由..."
bt log add <ID> error "错误：... 原因：... 方案：..."
bt log add <ID> milestone "阶段1完成：..."
bt log ls <ID> [--type finding]
```

### 记忆库（长期记忆）
```bash
bt mem add "飞书 API 限制" "image API 不支持 interactive 消息类型" -t 教训
bt mem search "飞书"
bt mem ls
```

### 子任务（内联在父任务行）
```bash
bt task add "子任务A" --parent <父ID>
bt subtask done <父ID> "子任务A" -s "完成摘要"
# 最后一个子任务完成 → 父任务自动标完成
```

## 内置安全机制

| 机制 | 说明 |
|------|------|
| 📏 内容截断 | 日志超 500 字自动截断，提醒用 `--file` 附件 |
| 🔄 注意力刷新 | 每 10 条日志提醒 `bt task show`，防止跑偏 |
| 📋 Plan 必须先写 | 没写计划就记日志会警告 |
| 🚫 错误协议 | 追踪错误次数，必须改变方法才能重试 |
| ✅ 完成检查 | `bt task done` 时检查 plan + milestone 是否齐全 |

## 工作流规则

### 双动作规则
每做 2 次搜索/浏览操作 → 立刻 `bt log add finding`，不等不攒。

### 上下文卸载
工具输出不留在上下文，立刻写入日志表。上下文只保留：`"已写入日志表 recXXX"`

### 错误协议
```
失败 #1 → 换方式 → bt log add error
失败 #2 → 彻底换方法 → bt log add error  
失败 #5 → 自动阻塞 + 通知 owner
```

**铁律：永远不要重复失败的动作。**

## 配置

`bt setup` 生成 `bitable_config.json`：

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
- `FEISHU_APP_ID` — 飞书应用 ID
- `FEISHU_APP_SECRET` — 飞书应用 Secret
- `BT_OWNER_OPEN_ID` — Owner 的飞书 open_id（用于通知）
- `BT_MAX_ERROR_RETRIES` — 最大错误重试次数（默认 5）

## 作为 OpenClaw Skill

本项目同时是一个 [OpenClaw](https://github.com/openclaw/openclaw) Skill，可以直接安装：

```
bitable-memory/
├── SKILL.md              # Skill 描述（给 Agent 看的操作指南）
├── README.md             # 人类文档
└── scripts/
    ├── bt                # CLI 主程序（Python）
    ├── bt_setup.py       # 初始化脚本
    └── bitable_config.json  # 配置文件（setup 后生成）
```

## 灵感来源

本项目的上下文管理策略参考了 [Manus](https://manus.im) 的上下文工程方法：
- `task_plan.md` → 任务表
- `findings.md` + `progress.md` → 执行日志表
- 长期记忆 → 记忆库（Manus 没有的扩展）

## License

MIT
