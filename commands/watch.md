---
description: 武装或撤下本窗口的总线 watcher
---

参数：`$ARGUMENTS`（`on` / `off` / 省略则显示状态）

- 省略（空参数）：**只显示状态，不要武装**——运行
  `node "${KIMI_PLUGIN_ROOT}/bin/bus.mjs" whoami --json`，把 `deaf` 字段展示给用户
  （`null` = 在听；`never` / `dead` / `expired` = 聋，并说明可以敲 `/agent-bus:watch on` 武装）。
- `off`：告诉用户本窗口将不再收到 `@` 通知，并提醒他用 `kill <watcher_pid>` 结束（pid 见 `whoami --json`）。
- `on`：检查 `whoami --json` 的 `deaf` 字段；不为 `null` 就用 `Bash` 起一个后台任务
  `node "${KIMI_PLUGIN_ROOT}/bin/bus.mjs" watch --timeout 43200`。`deaf` 已经是 `null` 就别重复武装。
