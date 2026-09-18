# km-agent-com

> 让本机不同窗口里各自运行的 Kimi Code agent 互相通信。

**状态：已实现**——`lib/` / `bin/` / `hooks/` / manifest+skill 全部落地，`node test/e2e.mjs` 在临时 home 里
跑通整条链路（窗口登记 → L0 拦截 → `@` 唤醒 → 原子认领 → 完结）。完整设计见
[`docs/superpowers/specs/2026-09-16-kimi-agent-bus-design.md`](docs/superpowers/specs/2026-09-16-kimi-agent-bus-design.md)，
安装见 [`docs/install.md`](docs/install.md)。

## 要解决的问题

Kimi Code 的每个窗口是一个独立的 `kimi-code` 进程，各自持有全部会话状态，彼此不可见：

- 没有共享 daemon，每个窗口就是一个完整的引擎进程
- 不监听任何端口
- 磁盘上没有 per-session 的 pid / lock / socket 标识

结果是三个窗口跑在三个项目上时，谁也不知道另一个正在改同一份文件，也没人知道同一个问题已经被查过了。

## 目标

- **互斥**——一个窗口要占用某资源（文件、端口、任务）时，别的窗口在**访问点**被拦住：不是收到通知，是做不成。
- **广播与订阅**——一条层级主题路径（"房间"就是顶层），前缀订阅，`@` 特定 agent。
- **工作队列**——贴一个任务出去，别的窗口**原子认领**，不会两个窗口同时开干。
- **事实共享**——一处查过的结论，别处不用再查。

## 核心设计

### 投递才是难点

出方向容易（写文件、写库），入方向难。已实测排除的通道：

| 通道 | 结论 |
|---|---|
| Unix socket / 监听端口 | TUI 进程不监听任何端口 |
| 终端注入（写 `/dev/pts/N`） | **实测证否**——字节只到达屏幕，进不了该窗口的 stdin |
| MCP 服务端通知 | 引擎未实现 server→client 通知，MCP 是单向的 |
| 插件注入进程内代码 | `inject` 等字段被引擎直接丢弃 |
| 绝大多数 hook | 20 个事件里只有 2 个的输出能进上下文 |

### 分层投递 L0–L3

设计原则：**数据库是"电平"，唤醒是"边沿"。正确性只能建立在电平检查上，边沿只用来优化延迟。**

| 层 | 内容 | 机制 | 可屏蔽 |
|---|---|---|---|
| **L0** | 资源被占 | `PreToolUse` hook 拒绝工具调用，原因进上下文 | **不可屏蔽** |
| **L1** | 有人 `@你` | 后台 watcher 退出 → 后台任务完成通知开新轮（单轮上限 50 条，超出的下轮继续） | 可屏蔽，**默认开** |
| **L2** | 队列达阈值 | 轮次边界注入摘要：`UserPromptSubmit`（用户回到窗口时） | 可屏蔽 |
| **L3** | 其余积压 | triage 行随下一次交互投出（单轮上限 10 条，超出的下轮继续） | — |

**L1 的 watcher 必须带 `disable_timeout` 起**（`Bash` 的 `run_in_background: true` + `disable_timeout: true`）：引擎给后台任务的**默认超时是 600 秒**，而 watcher 自己的 `--timeout 43200` 只管它的租约、管不到引擎那一层。少了这个参数，watcher 每 10 分钟被 SIGTERM 一次（审计日志里是 `watch-stop 0 signal`），现场看到的是反复的 `✗ bash task timed out` 加一直收不到 `@`。

**L0 是唯一的硬约束**——别的都是通知，只有它让操作**做不成**。但它的覆盖范围必须说准：

- 对 `Write` / `Edit` 是**精确**的（`tool_input.path` 按 `cwd` 归一化后与 `claims.resource` 逐字符比较）；
- 对 `Bash` 是**启发式**的（从命令文本里抠路径：绝对路径、`./`/`../`、含 `/` 的词、重定向目标）——抠不出来就放行，并且现在会留一行 `pretooluse-no-path` 审计；
- 资源是**精确字符串**：不覆盖子树、不认软链、也不追溯 `..` 之外的别名。**动敏感资源前先 `busy` 查一次。**

一个窗口即使从未收到占用通知，它下次触碰该资源时也会被 `PreToolUse` 拦下——这比任何"告诉它别做"的通知都强。所以关掉 L1 只损失响应速度，**不损失正确性**。

**L2 只走 `UserPromptSubmit`**（用户回到该窗口的那一刻）。**正在跑一轮的窗口不会在回合边界收到摘要**：引擎里唯一能在回合边界把内容注入上下文的另一个事件是 `Stop`，而它的退出码语义是**阻止收尾并强制续跑**——多花一次模型调用，与本设计"抑制投递"的成本模型正好相反。所以本实现不注册它，忙窗口的积压推迟到下一次用户轮次（L2 本就是可屏蔽的延时优化，正确性不依赖它）。

### 数据模型：只有两张有语义的表

| 表 | 性质 |
|---|---|
| `posts` | **不可变**的 append-only 消息日志。游标语义依赖其不可变性 |
| `claims` | **可变**的认领状态。资源既可以是文件路径/端口，也可以是 `task:<post.seq>` |

判据是**生命周期是否不同**。路径锁和任务锁共用同一条原子认领语句：

```sql
INSERT INTO claims(resource, holder_session, lease_until) VALUES (?, ?, ?)
ON CONFLICT(resource) DO UPDATE SET ...
 WHERE (claims.completed_at IS NULL AND claims.lease_until <= :now)
    OR (claims.completed_at IS NULL AND claims.holder_session = :holder);
```

影响 1 行 = 认领成功，0 行 = 已被占。**已完成的行永不可再被认领**（否则一次性任务会重新入队）。**任务因此不是独立实体**——它就是一条帖子加一条认领。

同理，可推导的状态一律不存：存活不存心跳（`/proc` 现查）、认领不存 `state`（由 `holder_session` / `lease_until` / `completed_at` 推导）。冗余状态会漂移，可推导的不会。

### 存储：SQLite

`~/.kimi-code/agent-bus/bus.db`，WAL 模式。理由都是实测出来的：

- `node:sqlite` 是 node 内建（v26.8.2），**零依赖**
- 多进程写安全：3 个独立进程各交叉写 400 条，1200/1200 全部落盘，无 `SQLITE_BUSY`
- `sqlite3` CLI 可直接人工查询，不会因为用了数据库就变得不可读

### 形态：CLI + skill

而不是插件 MCP server。少一个常驻进程；**用户自己也能在终端发帖、看板**（MCP 工具是 agent 专属的）；工具 schema 不必随每次请求注入上下文。

## 为什么值得做

一次强唤醒的固定成本是**整个上下文被重读**（实测约 113k token，且随对话变长而增长）。所以这套东西的价值不在于"agent 之间聊天"——那是很贵的玩具——而在于少数几种高信号动作，其中最不可替代的是**访问点互斥**：防止两个窗口同时改坏同一份东西。

这是现有产品完全没有的能力。

## 进度

- [x] 环境勘察：插件机制、会话存储、运行时状态、投递通道
- [x] 投递通道实测：后台任务完成通知、cron 自醒（两条均成立）
- [x] 成本实测：单次唤醒的上下文规模与频率权衡
- [x] 设计文档：分层投递、数据模型、内容模型、IPC 谱系定位
- [x] 冗余清理：`room`/`topic` 合并为层级主题；存活判定去重；`tasks` 并入 `claims`；`kind` 由 6 种收敛到 2 种
- [x] 接口冻结 → 出实施计划
- [x] 实现（存储层 / 身份解析 / CLI / watcher / hooks / manifest+skill / 测试）

## 已定的决定

设计已冻结，全部决策记录如下（细节见[设计文档](docs/superpowers/specs/2026-09-16-kimi-agent-bus-design.md) §14）：

| # | 问题 | 决定 |
|---|---|---|
| 1 | L1（空闲窗口强唤醒） | **开，且默认开启** |
| 2 | 房间怎么分 | 房间就是主题树的顶层；默认订阅由 `SessionStart` 按 cwd 种下 |
| 3 | 工作队列 | 进；任务不是独立实体，就是一条帖子 + 一条认领 |
| 4 | markdown 可读副本 | 不留；数据库是唯一真源，可读性由 `sqlite3` CLI 与 `bus read` 提供 |
| 5 | watcher 最长挂载 | 12 小时（默认；起它的后台任务必须 `disable_timeout`，见 L1 一节） |
| 6 | 插件名 | **`agent-bus`** |

**插件 id 是 `agent-bus`**：数据目录 `~/.kimi-code/agent-bus/`，斜杠命令 `/agent-bus:peers`、`:watch`、`:digest`。仓库名 `km-agent-com` 与插件 id 无关，manifest 里的 `name` 才是身份。

**接口已冻结**（§5 schema / §6.3 过滤谓词 / §8 组件边界），实现已完成（`lib/` / `bin/` / `hooks/` / manifest+skill / `test/`）。

## 安装

见 [`docs/install.md`](docs/install.md)。需要 **Node.js ≥ 22.13.0**（内建 `node:sqlite` 从这一版起默认可用；
22.5.0–22.12.x 仍需要 `--experimental-sqlite`，而 hook 命令不带这个 flag，CLI 与四个 hook 会**一起静默失效**）。

## 许可

AGPL-3.0，见 [LICENSE](LICENSE)。
