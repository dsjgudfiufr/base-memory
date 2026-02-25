# 📋 任务执行规范 — Manus 上下文工程 × Base 实现

> **核心原则**：上下文窗口 = RAM（易失、有限）。Base = Disk（持久、无限）。
> Manus 用 3 个 markdown 文件记录任务；bm 用 3 张 Base 表实现同等功能。

## 三表 = 三文件

| Manus 文件 | Base 对应 | 作用 |
|---|---|---|
| `task_plan.md` | **任务表** | 目标/当前阶段/关键问题/决策/错误 |
| `findings.md` | **执行日志表**（finding/decision/resource 类型）| 研究发现/技术决策/资源/视觉内容 |
| `progress.md` | **执行日志表**（milestone/progress/error/checkpoint 类型）| 进度日志/测试结果/错误日志 |

> **记忆库** = 长期记忆（跨任务经验沉淀，Manus 没有的扩展）

---

## 📬 任务接收协议

收到用户消息时，**先判断类型再行动**：

| 特征 | 类型 | 处理 |
|---|---|---|
| 含动词+交付物（帮我做X / 写Y / 分析Z / 实现W / 查...） | ✅ 任务 | 先建 Base，再调度执行 |
| 回复 / 澄清 / 反馈 / 问答 / 短确认 | 💬 对话 | 直接回复，不建表 |

> **原则：收到任务不直接执行，先入队 Base，由调度器决定执行顺序。**

### 两种调度模式

| 模式 | 说明 | 适用场景 |
|---|---|---|
| **LLM 调度**（`bm task next`） | LLM 自己查表、判断优先级、执行 | 简单场景、单 agent |
| **代码驱动调度**（`bm-dispatch`） | 独立进程循环查表 → 拼 prompt → spawn LLM → 解析结果写表 | 生产环境、需要可靠性 |

> 代码驱动调度的核心思想：**LLM 不碰表，代码管进度**。bm-dispatch 负责读任务、构建 prompt、调用 LLM、解析结果、更新状态，LLM 只需专注执行并返回结构化 JSON。

### 启动任务（LLM 调度模式）

```bash
bm task next                         # 0. 调度器：确认现在该做什么
bm task search <关键词>              # 1. 检索历史任务（避免重复踩坑）
bm task add <名称> -i "原始指令" [-p 优先级]  # 2. 建任务
bm task phase <id> "阶段1-需求探索"           # 3. 设置当前阶段
bm log add <id> plan "..."                    # 4. 写计划日志（不允许跳过）
```

### plan 日志格式

```
目标：一句话描述最终状态
阶段：1-需求探索 → 2-规划设计 → 3-实现 → 4-测试验证 → 5-交付
关键问题：① ... ② ...
约束：...
```

### 优先级识别

| 用户用词 | 设置优先级 |
|---|---|
| 高优 / 紧急 / 急 / 优先 / 尽快 | `-p 紧急` → 🔴 |
| 重要 / 尽快 | `-p 重要` → 🟡 |
| 其他（默认） | `-p 普通` → 🟢 |

### 父子任务结构

| 条件 | 是否拆子任务 |
|---|---|
| 单一目标，一条线做完 | ❌ 不拆 |
| 多个独立子问题，需分步交付 | ✅ 拆 |
| 预估超过 10 次工具调用 | ✅ 拆 |
| 需要阶段性确认/交付 | ✅ 拆 |

> 子任务**内联在父任务行**（不建独立 Base 行），用 `bm subtask done` 完成。
> 最后一个子任务完成 → 父任务自动标记完成。

---

## 标准五阶段 Checklist

```
阶段1-需求探索：理解用户意图 / 识别约束和需求 / 记录发现到日志表
阶段2-规划设计：定义技术方法 / 规划结构 / 记录决策及理由
阶段3-实现：    逐步执行计划 / 先写文件再执行 / 增量测试
阶段4-测试验证：验证所有需求满足 / 记录测试结果 / 修复发现的问题
阶段5-交付：    审查所有输出 / 确保交付物完整 / 向用户汇报
```

### 阶段转换（每个阶段完成时必须执行）

```bash
bm task phase <id> "阶段2-规划设计"         # 更新 Current Phase
bm log add <id> milestone "阶段1完成：..."   # 记录里程碑
bm task next                                 # ⚠️ 中断检查！有更高优先级任务？
```

### 中断检查

```
bm task next 输出：
├─ 当前任务仍是最高优先级 → 继续执行
└─ 有更高优先级任务 → bm task interrupt <当前ID> -m "断点描述"
                    → 转去执行高优先级任务
                    → 高优完成后 bm task resume 恢复
```

---

## 🧠 Sub-Agent 分层执行（防遗忘机制）

> **核心思想**：参考 Claude Code 架构——主 agent 只负责规划和检查进度，具体执行交给 sub-agent。
> 主 session 上下文始终保持"规划视角"，进度更新是调度流程的自然环节，不会遗忘。

### 判断标准

| 条件 | 执行模式 |
|---|---|
| 无子任务，或 ≤2 个简单子任务 | 主 session 直接执行 |
| ≥3 个子任务，且预估较复杂 | **Sub-Agent 分层模式** |
| 单个子任务但预估 >15 次工具调用 | **Sub-Agent 分层模式** |

### 主 Session（规划者）职责

```
1. 收到任务 → 拆子任务 → bm task add --parent
2. 逐个派发：
   a. bm subtask phase <id> "子任务A" "进行中"     ← 更新进度（用户可见）
   b. spawn sub-agent 执行子任务A                    ← 具体执行交出去
   c. 等待 sub-agent 返回结果                        ← 主 session 上下文不被污染
   d. 确认结果 → 下一个子任务（sub-agent 已自动 bm subtask done）
   e. bm task next                                    ← 中断检查
3. 全部完成 → bm task done → 回复用户
```

### Sub-Agent（执行者）职责

- 专注执行单个子任务
- 在自己的上下文里自由使用工具（不污染主 session）
- 完成后自己执行 `bm subtask done <父任务ID> "子任务名" -s "摘要"`
- 完成后返回结果摘要（自动 announce 回主 session）
- 遇到错误在自己上下文里重试，失败才上报

### spawn 模板

```
task: |
  执行子任务：[子任务名称]
  
  背景：[父任务目标]
  具体要求：[子任务描述]
  相关文件：[文件路径]
  约束：[注意事项]
  
  完成后必须执行：
    bm subtask done <父任务ID> "子任务名" -s "你的摘要"
  
  返回：
  1. 做了什么（一句话）
  2. 产出物路径/结果
  3. 遇到的问题（如有）
```

---

## 🔍 发现记录

| 类型 | bm 命令 | 触发时机 |
|---|---|---|
| 需求 | `bm log add <id> plan "需求：..."` | 任务启动时 |
| 研究发现 | `bm log add <id> finding "发现：..."` | **每 2 次**搜索/查看操作后 |
| 技术决策 | `bm log add <id> decision "决策：A 不用 B，理由：..."` | 做出重要技术选择时 |
| 遇到的问题 | `bm log add <id> error "问题：...\n解决：..."` | 遇到错误时 |
| 资源 | `bm log add <id> resource "URL/路径"` | 发现有用链接/文件时 |
| 视觉发现 | `bm log add <id> finding "截图显示：..."` | **看完图片/截图后立刻写** |

### 🔴 双动作规则（强制）

每做 **2 次** 搜索/浏览器/查看操作，**立刻** 写一条 `finding` 日志，不等不攒。

### 🔴 视觉内容立刻文字化

看到图片/PDF/截图/浏览器结果 → **当场** `bm log add finding`，多模态内容不持久！

---

## 📊 进度日志

| 类型 | bm 命令 |
|---|---|
| 阶段行动记录 | `bm log add <id> progress "做了什么" --phase "阶段N"` |
| 创建/修改的文件 | `bm log add <id> resource "文件：/path/to/file"` |
| 阶段完成 | `bm log add <id> milestone "阶段N完成：..."` |
| 测试结果 | `bm log add <id> finding "测试：[名称] \| 预期：Y \| 实际：Z \| ✅/❌"` |
| 错误日志 | `bm log add <id> error "错误：...\n原因：...\n方案：..."` |

### 🔴 错误协议（强制）

```
第1次失败 → 诊断，换方式       → bm log add error
第2次失败 → 彻底换方法         → bm log add error
第3次失败 → 再次沉淀后换方法   → bm log add error
第5次失败 → 系统自动 block + 通知 owner 介入
```

> **门禁机制**：必须先改变方法，才能再尝试。错误次数由系统自动计数。

**🚫 核心铁律：永远不要重复失败的动作。**

### 5问重启检查（`bm task resume`）

| 问题 | 数据来源 |
|---|---|
| 我在哪里？ | 任务表 `当前阶段` |
| 去哪里？ | 最近 plan 日志 |
| 目标是什么？ | 任务表 `原始指令` |
| 学到什么？ | 最近 finding/decision 日志 |
| 做了什么？ | 最近 milestone/progress 日志 |

---

## 🗄 上下文卸载规则（强制）

工具调用结果 **不留在上下文**，立刻写入日志表。上下文只保留：`"已写入日志表 recXXX"`

### 读写决策矩阵

| 情况 | 动作 | 原因 |
|------|------|------|
| 刚写了内容 | **不要**重读 | 内容仍在上下文中 |
| 看了图片/PDF | **立刻** `bm log add finding` | 多模态不持久 |
| API 返回大数据 | `bm log add tool` + `--file` 附件 | 大响应不持久 |
| 开始新阶段 | `bm task show` 重读目标 | 上下文陈旧 |
| 发生错误 | `bm log add error` | 记录现场 |
| 中断后恢复 | `bm task resume` | 5问重启 |
| 丢弃大内容 | 先 `bm log add resource` 保留指针 | 指针不能丢 |

### 内容长度约束

| 位置 | 限制 | 超出时 |
|------|------|--------|
| 日志表 `内容` | ≤500 字 | `--file` 附件 |
| 任务表 `任务进展` | ≤300 字 | `bm log add checkpoint` |
| 任务表 `结果摘要` | ≤200 字 | 重写 |

### 注意力刷新

每 >10 次工具调用后，或开始新阶段前：

```bash
bm task show <id>   # 重读目标/原始指令/当前阶段，防止跑偏
```

重大决策前：先 `bm task show <id>` 把目标拉回注意力窗口，再做决策。

---

## ✅ 任务完成

```bash
bm task done <id> -s "结果摘要（≤200字）"
```

完成后沉淀结论：
- 流程/行为改进 → 更新配置或规则
- 技术知识/经验 → `bm mem add`
- 已修复的 bug → 代码本身即沉淀

---

## 💬 与用户沟通节点

| 类型 | 场景 | 做法 |
|---|---|---|
| `info` | 长任务执行中 | 每完成一个阶段后告知 |
| `ask` | 需要外部决策/信息 | `bm task block` + 说明卡点 |
| `result` | 任务完成 | `bm task done` + 总结回复 |

**规则：** 中间步骤不打扰；阻塞才发 `ask`；完成才发 `result`。

---

## 🔄 受控变化原则（防漂移）

- 连续做同类操作 3 次以上 → 停下来重新校准
- 不要盲目复制之前成功的模式到新场景
- 每次决策前 `bm task show <id>`（"读前决策模式"）

---

## 🤖 代码驱动调度（bm-dispatch）

> LLM 不碰表，代码管进度。

### 架构

```
bm-dispatch（Node 进程）
  ├─ 循环查 Base 任务表（fetchNextTask）
  ├─ 按优先级+状态排序，取最高优先级任务
  ├─ 识别子任务（findFirstIncompleteSubtask）
  ├─ 构建 prompt（buildPrompt）— 含任务目标、规划、进度、日志
  ├─ 调用 LLM（callLLM）— 通过 OpenClaw hooks/agent
  ├─ 解析结果 JSON（parseResult）
  └─ 更新 Base（done/error/blocked 三种状态）
```

### 三个触发入口

| 入口 | 说明 |
|---|---|
| `node bm-dispatch.mjs` | 持续循环（生产模式） |
| `node bm-dispatch.mjs --once` | 单轮执行（测试用） |
| `node bm-dispatch-startup.mjs` | 网关启动时自动恢复 |

### LLM 输出格式

LLM 执行完任务后，必须返回结构化 JSON：

```json
// 成功
{"status": "done", "summary": "一句话摘要", "files": ["产出文件路径"]}

// 阻塞（需人工介入）
{"status": "blocked", "reason": "阻塞原因"}

// 失败
{"status": "error", "message": "错误信息"}
```

### 错误处理

- 错误次数由代码自动计数（`错误次数` 字段）
- 第 N 次失败：当前阶段追加 `⚠️ 第N次失败` 标记
- 第 5 次失败：自动标记 `🔒阻塞` + 飞书通知 owner
- 重试时 prompt 包含历史错误日志，要求 LLM 换方法

### 配置

```bash
# 环境变量
BT_POLL_INTERVAL_MS=30000    # 主循环间隔（默认 30s）
BT_MAX_ERROR_RETRIES=5       # 最大错误重试次数
BT_LLM_TIMEOUT_MS=600000     # LLM 调用超时（默认 10min）
BT_OWNER_OPEN_ID=xxx         # 飞书通知接收人（可选）
```

---

## ❌ 反模式对照

| 不要 ❌ | 改为 ✅ |
|---|---|
| 没有计划就开始执行 | 先 `bm task add` + `bm log add plan` |
| 陈述一次目标后就忘记 | 决策前 `bm task show` 重读 |
| 隐藏错误悄悄重试 | `bm log add error` 记录现场 |
| 重复同样失败的动作 | 每次失败必须改方法 |
| 工具调用结果留在上下文 | 立刻 `bm log add` 卸载 |
| 大内容塞进日志字段 | 超 500 字用 `--file` |
| 视觉内容留在上下文 | 看完立刻 `bm log add finding` |
| 每步都通知用户 | 完成才发 `result`，卡住才发 `ask` |
| 复杂任务自己全做 | Sub-Agent 分层：主 session 规划+调度，sub-agent 执行 |
| 批量 subtask done | 逐个推进：phase → spawn → 等结果 → done → 下一个 |
| LLM 直接读写 Base 表 | 用 bm-dispatch 代码驱动，LLM 只返回结果 JSON |
