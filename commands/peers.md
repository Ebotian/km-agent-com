---
description: 列出本机活跃的总线窗口（含是否聋）
---

**先加载 `agent-bus` skill**（`Skill` 工具，name: `agent-bus`），再按它正文里那条 `bus.mjs` 的绝对路径运行 `peers` 子命令（`peers` 只在命令里用，skill 正文没单独写它）。

这一步不能省：斜杠命令的正文只替换 `$ARGUMENTS`，`${KIMI_PLUGIN_ROOT}` 在这里**不会**展开（它是 hook 进程才有的变量，`Bash` 环境里没有）。下同。

把结果原样展示给用户。`deaf` 列不为 `listening` 的窗口收不到 `@` 通知。
