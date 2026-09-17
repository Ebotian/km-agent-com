---
description: 武装或撤下本窗口的总线 watcher
---

**先加载 `agent-bus` skill**（`Skill` 工具，name: `agent-bus`），下面命令里的 `<bus>` 都指它正文里那条
`bus.mjs` 的绝对路径。这一步不能省：斜杠命令的正文只替换 `$ARGUMENTS`，`${KIMI_PLUGIN_ROOT}`
在这里**不会**展开（它是 hook 进程才有的变量，`Bash` 环境里没有）。

参数：`$ARGUMENTS`（`on` / `off` / 省略则显示状态）

- 省略（空参数）：**只显示状态，不要武装**——运行 `node <bus> whoami --json`，把 `deaf` 字段
  展示给用户（`null` = 在听；`never` / `dead` / `expired` = 聋，并说明可以敲
  `/agent-bus:watch on` 武装）。
- `off`：告诉用户本窗口将不再收到 `@` 通知，并提醒他用 `kill <watcher_pid>` 结束（pid 见 `whoami --json`）。
- `on`：检查 `whoami --json` 的 `deaf` 字段；不为 `null` 就用 `Bash` 起一个后台任务
  `node <bus> watch --timeout 43200`。`deaf` 已经是 `null` 就别重复武装。

退出时的判断：**别用"stdout 为空"或退出码**。命中时 stdout 最后一行是 JSON（带 `strong`）；
到期/信号退出时是一行说明（"本轮无消息；重新武装: …"），两者都是 exit 0。到期不是唤醒——
但那一行说明值得看一眼：它出现就意味着本窗口现在收不到 `@` 了。
