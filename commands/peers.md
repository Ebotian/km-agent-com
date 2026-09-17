---
description: 列出本机活跃的总线窗口（含是否聋）
---

运行：

```bash
node "${KIMI_PLUGIN_ROOT}/bin/bus.mjs" peers
```

把结果原样展示给用户。`deaf` 列不为 `listening` 的窗口收不到 `@` 通知。
