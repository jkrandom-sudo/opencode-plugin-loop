# opencode-plugin-loop

**[English](README.md) | [简体中文](README.zh-CN.md)**

[![npm version](https://img.shields.io/npm/v/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![CI](https://github.com/jkrandom-sudo/opencode-plugin-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/jkrandom-sudo/opencode-plugin-loop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jkrandom-sudo/opencode-plugin-loop/blob/main/LICENSE)

一个即插即用的 [opencode](https://opencode.ai) `/loop` 命令，参照 Claude Code 的 `/loop` 实现。每个 `/loop` 任务都绑定到创建它的会话 —— 绝不会泄漏到其他会话。

## 功能特性

- **`/loop 5m <提示词>`** — 固定间隔（支持 s/m/h/d），创建后立即运行，之后按计划重复执行
- **`/loop <提示词>`** — 自适应模式：立即运行，然后保留随机回退时间、根据结果重新调度，或把明确的重复节奏转换为固定任务
- **`/loop`** — 空命令：读取 `.opencode/loop.md`（项目级）或 `~/.opencode/loop.md`（用户级），或运行内置的维护任务，立即执行
- **`/loop 30s --once <提示词>`** — 一次性任务：触发一次后自动取消
- **`/proactive`** — `/loop` 的完整别名（与 Claude Code 对齐）
- **`/loop help`** — 在终端中查看完整用法、标志和示例
- **Claude Code 风格标志** — `--cancel/--list/--status/--pause/--resume/--stop/--stop-all` 映射到对应的子命令
- **按会话隔离** — 任务绑定到某个 `sessionID`；其他会话看不到、不会触发、也无法管理这些任务
- **子命令** — `list | status | cancel | stop | pause | resume | stop-all`（全部限定在当前会话；不带参数的 `stop` 取消会话中的所有任务）
- **内部定时器** — 5 秒循环驱动任务触发
- **提示词保真** — 标志（`--once`、`--jitter=*`）只在提示词开始之前被识别；`--` 强制把其余内容按原样视为提示词文本，空白和换行均保留
- **同进程多实例协调** — 同一进程内的多个插件实例（大小写变体的插件路径、每条命令一个 `opencode run` 实例）会选举出唯一 leader，任务绝不重复触发；同一项目中的第二个 OpenCode 进程会独立触发自己的任务，合并写入防止任务丢失
- **触发中（Inflight）保护** — 在定时器和 `fireTask` 两层设置标记，即使 opencode 热重载插件也不会重复触发
- **墙钟调度** — 固定任务以触发时刻为锚点；模型回合的时长永远不会拉长间隔
- **临时生命周期（默认）** — 任务随 OpenCode 进程退出而消亡，下次启动时被丢弃，与 Claude Code 的 `/loop` 一致。设置 `ephemeralTasks: false` 可在进程重启后保留任务
- **`session.deleted` 自动清理** — 该会话的所有任务会被自动取消
- **可配置的 Jitter** — 确定性的固定任务偏移，可按命令、工具调用或编程默认值控制
- **自动过期** — 空闲超过 7 天的任务在加载时被移除（活跃任务永不过期）
- **最多 50 个并发任务**
- **LLM 可调用的工具** — `loop_schedule`、`loop_status`（限定在调用它们的会话内）
- **Claude Code 风格的内联结果** — 每个 `/loop` 结果（创建、列表、取消、暂停、恢复、stop-all、失败）都由模型直接用用户的语言在对话中呈现 —— 任务列表渲染为 markdown 表格。无对话框、无 toast

## 环境要求

- OpenCode **1.17.18 或更新版本**
- Node.js **18 或更新版本**

## 安装

### 方式一：从 npm 安装（推荐）

使用 OpenCode 的插件安装器，它会同时检测包的 server 和 TUI 入口，并添加到正确的配置中：

```bash
opencode plugin opencode-plugin-loop --global --force
```

这会把不带版本号的包名同时添加到全局 `opencode.json` 和 `tui.json`，以后升级无需再编辑版本号。

如果你的 OpenCode 配置中还没有定义 `/loop`，请把下面展示的命令定义添加到 `opencode.json`。OpenCode 会从 npm 包中检测到两个插件入口，但目前不会把内置的 `commands/loop.md` 文件复制到你的配置目录。

### 升级

要把现有安装更新到当前的 npm 发布版本，重跑同一条命令即可：

```bash
opencode plugin opencode-plugin-loop --global --force
```

`--force` 标志会替换已安装的插件版本并刷新两个全局配置项，无需更改版本号。命令完成后重启 OpenCode。

**升级自检。** opencode 在 `~/.cache/opencode/packages` 维护它自己的插件包缓存，`--force` 并不总会刷新它。如果升级报告成功但行为没有变化（例如 `npm view opencode-plugin-loop version` 与你看到的不一致），清除缓存并重启：

```bash
rm -rf ~/.cache/opencode/packages/opencode-plugin-loop*
```

然后用 `/loop help` 验证 —— 新标志和子命令会立即在那里显示。

### 方式二：手动配置

在两个配置文件的 `plugin` 数组中加入同一个包名。

Server 配置（`~/.config/opencode/opencode.json`）：

```json
{
  "plugin": ["opencode-plugin-loop"],
  "command": {
    "loop": {
      "description": "Run prompts on a schedule. Intervals: s/m/h/d. Subcommands: help | list | status | cancel <id> | pause <id> | resume <id> | stop-all (all scoped to the current session)",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  }
}
```

TUI 配置（`~/.config/opencode/tui.json`）：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-plugin-loop"]
}
```

### 方式三：从源码安装（开发用）

```bash
git clone https://github.com/jkrandom-sudo/opencode-plugin-loop.git
cd opencode-plugin-loop
npm install
npm run build
opencode plugin "file:///absolute/path/to/opencode-plugin-loop" --global --force
```

编辑 `src/` 后重新运行 `npm run build`，然后重启 OpenCode 加载重新构建的文件插件。

## 用法

### 固定间隔
```
/loop 5m check if the deploy finished
/loop 30s ping the health endpoint
/loop 2h look for failing CI runs
/loop 2m --jitter=false check the latest package version
/loop 30s --once remind me to stretch   # 一次性：触发一次后自动取消
/loop check the deploy every 20m        # 尾部 "every" 子句 ≡ /loop 20m check the deploy
/loop check CI every 5 minutes          # 单词单位同样支持：seconds/minutes/hours/days
```

尾部 `every <间隔>` 子句会被确定性地提取（Claude Code 规则 2）：间隔生效，其余部分是提示词。`check every PR` —— "every" 后面没有时间表达 —— 不会被当作定时任务，保持为自适应模式。

重复执行的固定任务**在创建时立即运行**（Claude Code 行为）：创建回合就是它的第一次执行，之后按计划在锚定到创建时间的下一次触发时刻重复执行。`--once` 任务则立即变为到期状态，在一个定时器周期内触发一次，然后自动取消。

固定任务默认使用确定性的 Jitter。添加 `--jitter=false` 使用精确间隔，`--jitter=true` 显式启用。标志只在**提示词开始之前**被识别：第一个提示词单词之后的任何内容 —— 包括看起来像 `--once` 或 `--jitter=*` 的文本 —— 都是提示词的一部分，会被原样保留（包括空白和换行）。使用 `--` 强制把其后的所有内容视为提示词文本：

```
/loop 1m --once remind me to stretch        # --once 是标志（前缀位置）
/loop 1m explain what --once means          # --once 是提示词文本，原样保留
/loop 1m -- --jitter=false is a flag too    # -- 强制其余内容为提示词
```

### 自适应间隔（由 LLM 决定下次触发时间）
```
/loop check whether CI passed and address any review comments
/loop every two minutes check the latest opencode-plugin-loop version
```

自然语言形式会在当前模型回合中立即执行该请求。每个自适应任务首先获得一个在配置的 1–60 分钟范围内的持久化随机回退时间。完成请求后，LLM 对调度进行分类：

- 明确的稳定节奏（如 "every two minutes"）会调用 `loop_schedule(action="set_fixed", intervalMs=120000)`，变为永久固定任务；
- 依赖结果决定下次检查的调用 `loop_schedule(action="reschedule", delayMs=...)`；
- 合适的回退时间通过不做任何调度调用来保留；
- 已完成且未来无需再检查的任务调用 `loop_schedule(action="cancel")`。

自适应转固定的任务默认 `jitterEnabled: false`，因此显式节奏保持精确。

回退时间在提示词注入之前写入。因此一次成功的 `reschedule` 会替换回退时间，且不会在模型结束后被覆盖。首选的 `delayMs` 相对于工具调用时刻，避免了 epoch 运算。范围内模型延迟会被精确存储、不加 Jitter；只有超出范围的请求才会被钳制到该任务配置的最小或最大延迟。固定任务和维护任务的重新调度保持不变。也接受绝对时间 `nextDueAtMs`，但同时传入它和 `delayMs` 会返回错误且不改变任务。

### 裸 `/loop` — 自定义默认提示词
创建 `.opencode/loop.md`（项目级）或 `~/.opencode/loop.md`（用户级，项目没有时使用），写入你的维护指令：
```markdown
Check the release branch PR. If CI is red, pull the failing log,
diagnose, and push a minimal fix. If new review comments have arrived,
address each one. If everything is green, say so in one line.
```

该文件**每次运行都会重新读取**（Claude Code 行为）：编辑 loop.md 会在下一次触发时以完整的新内容生效；内容不变时只注入一条简短提醒（对 prompt 缓存友好）；如果文件被删除，该次运行被跳过，任务保持待命状态。

### 子命令

所有子命令都**限定在当前会话** —— 在其他会话中创建的任务对它们不可见，与 Claude Code 按会话隔离的 `/loop` 作业完全一致。

```
/loop help                              # 完整用法、标志和示例
/loop list                              # 显示当前会话的任务
/loop status                            # list 的别名
/loop cancel <taskId>                   # 取消当前会话中的一个任务
/loop stop <taskId>                     # cancel 的别名
/loop stop                              # 取消当前会话中的 ALL 任务
/loop pause <taskId>                     # 暂停一个
/loop resume <taskId>                    # 恢复一个（按模式重新待命）
/loop stop-all                          # 取消当前会话中的所有任务
```

尝试管理属于其他会话的任务会报告 "No task `<id>` in this session" —— 切换到该会话后再管理。`loop_schedule` 和 `loop_status` 工具同样适用这种严格隔离。

### 从 Claude Code 迁移

| Claude Code `/loop` | opencode-plugin-loop |
|---|---|
| `/loop 5m <提示词>` | 完全一致 —— 创建时立即运行，之后重复执行 |
| 尾部 "every" 子句（`... every 20m`） | 完全一致 —— 被确定性提取为固定间隔 |
| `/loop <提示词>`（自定节奏） | 自适应：立即运行，模型选择下次检查时间（回退 1m–1h） |
| `/proactive` | 别名：`/proactive` 与 `/loop` 行为完全一致 |
| 通过 cron 工具取消/列表 | `/loop cancel <id>`、`/loop list` |
| `--cancel`、`--list`、`--stop` | 均接受 —— 映射到 `cancel`、`list`、`stop` |
| 一次性提醒（"in 30m tell me X"） | `/loop 30s --once <提示词>` |
| 会话结束时作业消亡 | 默认行为一致（`ephemeralTasks: false` 可选退出） |
| cron 表达式（`*/5 * * * *`） | 不支持 —— 请使用 `5m` 形式（会给出明确错误） |

两个值得注意的行为差异：任务只对**当前活跃会话**触发（切换会话后其余任务等待；切回来后补触发一次），固定任务由 5 秒定时器触发而非精确墙钟 cron 时间（最多晚一个定时器周期）。

### 内联结果

每个 `/loop` 命令的结果都由模型直接在对话中呈现 —— Claude Code 风格，使用你使用的语言：

- **创建** — 简短的确认信息，包含任务、计划和作业 ID（以及如何取消）
- **列表 / 状态** — 你的任务以 markdown 表格展示（作业 ID、频率、内容、类型），下方附管理命令
- **取消 / 暂停 / 恢复 / stop-all** — 简洁地说明发生了什么变化，以及该任务是否会再次触发
- **失败** — 简要说明出错原因

无对话框、无 toast —— 对话就是唯一的输出界面。

### 编程方式（LLM 工具）

插件注册了两个 LLM 可调用的工具。两者都限定在调用它们的会话内。

```typescript
loop_schedule({
  action: "create",
  prompt: "check the deploy",
  intervalMs: 300_000,
  // sessionID 自动从 ctx 绑定
})

loop_schedule({
  action: "cancel",
  taskId: "abc12345",
  // 只对调用会话中创建的任务有效
})

loop_schedule({
  action: "reschedule",
  taskId: "abc12345",
  delayMs: 5 * 60_000,
})

loop_schedule({
  action: "set_fixed",
  taskId: "abc12345",
  intervalMs: 2 * 60_000,
  jitterEnabled: false, // 自适应转固定的默认值
})

loop_status({})               // 当前会话
```

## 配置

`plugin` 数组中的包名是 `opencode.json` 中唯一需要的插件专属配置项。当前的 OpenCode 版本会校验该文件，并拒绝 `"opencode-plugin-loop"` 这类任意的顶层键。

内置运行时默认值：

| 设置项 | 默认值 |
|---------|---------|
| 最大持久化任务数 | 50 |
| 任务过期时间 | 7 天 |
| 自适应回退范围 | 1 分钟到 1 小时 |
| 调度定时器 | 5 秒 |
| 新建固定任务 Jitter | 启用 |
| 临时任务 | 启用 |

**临时生命周期。** 启用 `ephemeralTasks`（默认）时，每个任务会在 `tasks.json` 中记录其所属进程（`ownerPid` + 启动时间）。加载时，确认所属进程已死亡的任务 —— 例如在 OpenCode 进程退出后 —— 会被丢弃，因此 loop 任务永远不会比创建它的进程活得更久（与 Claude Code 的 `/loop` 生命周期相同）。同一项目中由其他**存活**的 OpenCode 进程拥有的任务不受影响，每个进程只触发自己的任务。同进程内的插件热重载保留其任务。在插件选项中设置 `ephemeralTasks: false` 可让任务跨进程重启保留。

每个任务都会持久化自适应最小和最大延迟。随机回退和模型请求的 `reschedule` 都受该任务边界的约束。模型选择的自适应时间不会加 Jitter。

对于编程组合使用，`LoopConfig.defaultJitterEnabled` 控制新建的固定任务，默认为 `true`。显式的命令行 `--jitter=true|false` 或工具参数 `jitterEnabled` 会覆盖该默认值。没有 `jitterEnabled` 字段的已持久化固定任务视为 Jitter 开启。由于定时器每 5 秒检查一次，实际的提示词注入可能发生在精确到期时间之后最多一个定时器周期。

## 按会话的架构

每个 `/loop` 任务都带有 `sessionID` 字段：

| 生命周期事件 | 行为 |
|-----------------|----------|
| 用户在会话 A 中运行 `/loop` | 任务以 `sessionID = A` 创建 |
| 定时器每 5 秒触发 | 只触发 `sessionID === activeSessionID` 的任务（通过 `chat.message` 钩子跟踪） |
| 用户在会话 B 中运行 `/loop` | 会话 B 变为活跃；A 的任务等待 |
| 会话 A 的 `session.deleted` | A 的所有任务被自动取消 |
| 插件重载（`opencode` 热重载） | 旧定时器停止，新定时器启动；进行中的任务由 `inflight` Set 保护 |
| 进程重启（新 pid） | 启用 `ephemeralTasks`（默认）时，所属进程已死的任务在加载时被丢弃，其他存活进程拥有的任务不受影响；禁用时任务照旧恢复 |
| 无 `sessionID` 的旧 `tasks.json` | 加载时被丢弃（带日志消息） |

## 存储

任务持久化到 `.opencode/cache/loop/tasks.json`（按项目）。触发历史记录在存储旁边的 `history.log` 中。每个任务都记录其所有者的 `ownerPid` 和 `ownerStartedAt`，临时生命周期据此区分已死进程的残留任务和其他存活 OpenCode 进程拥有的任务。

## 故障排除

### 包入口

包暴露了独立的 `opencode-plugin-loop/server` 和 `opencode-plugin-loop/tui` 入口，使得自动加载两者的 OpenCode 安装保持可用（TUI 入口是空操作，因为结果以内联方式呈现）。根导出与 server 模块相同。编程使用的消费者应使用命名工厂：

```typescript
import { LoopPlugin } from "opencode-plugin-loop"
```

### 结果呈现

每个 `/loop` 结果都由模型以内联方式呈现 —— 没有任何内容直接写入终端，也不使用对话框或 toast。运行时诊断信息输出到 OpenCode 的结构化应用日志。

另外请确保插件只从一个来源安装。OpenCode 会从 `opencode.json` 和 `~/.config/opencode/plugins/` 下复制的插件独立加载 npm 插件，即使它们包名相同。

如果 `opencode.json` 中已经包含 `"plugin": ["opencode-plugin-loop"]`，检查是否有残留的复制安装：

```bash
ls ~/.config/opencode/plugins/opencode-plugin-loop
```

如果该目录存在，把它移出自动加载的插件目录并重启 OpenCode：

```bash
mv ~/.config/opencode/plugins/opencode-plugin-loop \
  ~/.config/opencode/plugins/opencode-plugin-loop.backup
```

保留备份直到 npm 安装验证通过，不需要时再删除。

## 许可证

MIT
