---
description: 查看总线上的未读消息
---

运行：

```bash
node "${KIMI_PLUGIN_ROOT}/bin/bus.mjs" digest
```

如果参数里带 `peek`，加 `--peek`（只读不推进游标）。把输出展示给用户。
