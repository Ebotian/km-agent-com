# 安装 agent-bus

## 前置

- Node.js ≥ 22.5.0（需要内建 `node:sqlite`）
- 本机用户级 Kimi Code（`~/.kimi-code/` 存在）

## 安装

插件以本地目录形式安装。把仓库克隆到任意位置后，在 Kimi Code 里指向它：

```bash
git clone https://github.com/Ebotian/km-agent-com.git ~/km-agent-com
```

然后在 Kimi Code 会话里执行 `/plugins install ~/km-agent-com`（或把目录软链到
`~/.kimi-code/plugins/managed/agent-bus`），之后 `/reload` 或 `/new` 让插件生效。

### 生效的是托管副本，不是这个克隆

`/plugins install <本地目录>` 会把目录**复制**到 `$KIMI_CODE_HOME/plugins/managed/agent-bus/`，
引擎之后只跑这份副本——**在克隆里改了代码不会生效**，改完要重装一次：

```
/plugins install ~/km-agent-com
/reload
```

反向不成立：`/plugins remove agent-bus` 只删安装记录，托管副本与克隆目录都留在磁盘上，得手工清。
hook 进程的工作目录被引擎设成插件根，并额外注入 `KIMI_CODE_HOME` 与 `KIMI_PLUGIN_ROOT`——
manifest 那条零成本预检就是靠 `KIMI_CODE_HOME` 找 `claims.marker`。

## 验证

在任何窗口里：

```bash
KIMI_PLUGIN_ROOT=~/km-agent-com node ~/km-agent-com/bin/bus.mjs peers
```

应列出本机所有活跃窗口。若列表里本窗口的 `deaf` 不是 `listening`，说明 watcher 没武装——
在会话里说一句「武装 watcher」，或直接跑：

```bash
node ~/km-agent-com/bin/bus.mjs watch
```

还想更彻底地自检，就在克隆里跑端到端脚本（全程在临时 home，不碰真实数据，也不动已装插件）：

```bash
node ~/km-agent-com/test/e2e.mjs
```

它跑完会打印 `E2E OK`：窗口登记 → L0 拦住跨窗口的资源争用 → `@` 秒级唤醒空闲窗口 → 读消息并
回复 → 任务被原子认领 → 完结，外加并发注册与预检门。

## 数据与清理

全部状态在 `~/.kimi-code/agent-bus/`：

| 文件 | 用途 |
|---|---|
| `bus.db` | 消息、认领、订阅、窗口登记 |
| `claims.marker` | 有活跃租约时存在；`PreToolUse` 的零成本预检读它 |
| `log.jsonl` | 审计日志，可随时删 |

卸载插件后直接删掉整个目录即可，不影响 Kimi Code 本身。

**自定义数据目录时注意**：上面路径里的 `~/.kimi-code` 是缺省值，CLI 与 hook 都按
`KIMI_CODE_HOME` 优先解析。但 manifest 的预检片段读的是 `$KIMI_CODE_HOME`，**没有回退**——
两者若不一致（例如手工 `KIMI_CODE_HOME=/x` 跑 CLI，而 hook 环境里没有这个变量），预检恒假 ⇒
`PreToolUse` 每次静默放行 ⇒ L0 全灭，且没有任何信号。所以要让 hook 环境与 Bash 环境看到同一个
`KIMI_CODE_HOME`。

## 排查

```bash
sqlite3 ~/.kimi-code/agent-bus/bus.db 'select seq, topic, kind, title from posts order by seq desc limit 20'
sqlite3 ~/.kimi-code/agent-bus/bus.db 'select resource, holder_session, lease_until from claims'
```

## 参考

- [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html) —— `/plugins install`、托管副本、hook 进程拿到的环境变量
- [Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) —— 退出码语义（`0` 放行 / `2` 拦下并把 stderr 作为理由进上下文）
