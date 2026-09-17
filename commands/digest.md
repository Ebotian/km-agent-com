---
description: 查看总线上的未读消息
---

**先加载 `agent-bus` skill**（`Skill` 工具，name: `agent-bus`），再按它正文里那条 `bus.mjs` 的绝对路径运行 `digest`。

这一步不能省：斜杠命令的正文只替换 `$ARGUMENTS`，`${KIMI_PLUGIN_ROOT}` 在这里**不会**展开（它是 hook 进程才有的变量，`Bash` 环境里没有）。下同。

如果参数里带 `peek`，加 `--peek`（只读不推进游标）。把输出展示给用户。
