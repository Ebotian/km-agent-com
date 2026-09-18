# 安装 agent-bus

## 前置

- Node.js ≥ 22.13.0（需要内建 `node:sqlite`；**22.5.0–22.12.x 不行**——那一档还得带
  `--experimental-sqlite`，而本插件的 hook 命令不带这个 flag：CLI 会每条命令都失败、
  四个 hook 会全部 fail-open，表现为"什么都没发生"）
- 本机用户级 Kimi Code（`~/.kimi-code/` 存在）

## 安装

插件以本地目录形式安装。把仓库克隆到任意位置后，在 Kimi Code 里指向它：

```bash
git clone https://github.com/Ebotian/km-agent-com.git ~/km-agent-com
```

然后在 Kimi Code 会话里执行 `/plugins install ~/km-agent-com`，之后 `/reload` 或 `/new` 让插件生效。

**必须走 `/plugins install`**：`$KIMI_CODE_HOME/plugins/installed.json` 才是插件的登记表，
引擎按它决定加载哪些插件、各自托管副本在哪。把目录手工复制（或软链）到
`plugins/managed/agent-bus/` 而不登记，**未必会被加载**——这条没验证过，也不建议。

### 生效的是托管副本，不是这个克隆

`/plugins install <本地目录>` 会把目录**复制**到 `$KIMI_CODE_HOME/plugins/managed/agent-bus/`，
引擎之后只跑这份副本——**在克隆里改了代码不会生效**，改完要重装一次：

```
/plugins install ~/km-agent-com
/reload
```

反向不成立：`/plugins remove agent-bus` 只删安装记录，托管副本与克隆目录都留在磁盘上，得手工清。
hook 进程的工作目录被引擎设成插件根，并额外注入 `KIMI_CODE_HOME` 与 `KIMI_PLUGIN_ROOT`——
manifest 那条零成本预检就是靠 `KIMI_CODE_HOME`（缺席时回退 `$HOME/.kimi-code`）找 `claims.marker`。

### `KIMI_PLUGIN_ROOT` 只在 hook 进程里，别指望 agent 的 `Bash` 看到它

引擎只把 `KIMI_PLUGIN_ROOT` 注入**插件的 hook 进程**；agent 的 `Bash` 工具继承的是 TUI
进程的环境，里面**没有**它（实测：在真实窗口的 `Bash` 里 `echo "${KIMI_PLUGIN_ROOT:-未设置}"`
打印"未设置"）。所以任何**给 agent 看的**片段都不能写 `node "${KIMI_PLUGIN_ROOT}/bin/bus.mjs"`
——它会展开成 `node "/bin/bus.mjs"` 而失败。

- **skill 正文**：用 `${KIMI_SKILL_DIR}/../../bin/bus.mjs`。`${KIMI_SKILL_DIR}` 是引擎在 skill
  正文里会替换的占位符（值是 `SKILL.md` 所在目录，本插件即 `<插件根>/skills/agent-bus`），
  往上两级就是插件根。
- **斜杠命令正文**：只替换 `$ARGUMENTS`，**`${KIMI_SKILL_DIR}` 与 `${KIMI_PLUGIN_ROOT}` 都不
  会展开**。所以 `commands/*.md` 不自己拼路径，而是让 agent 先加载 `agent-bus` skill、照
  skill 正文里的绝对路径执行。
- **终端里人手动跑**：用绝对路径（本页「验证」一节就是），与环境变量无关。

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

**在终端里手工跑**用上面这条就够了；**让 agent 去武装**时要交代一句：那个 `Bash` 后台任务必须带
`disable_timeout: true`。引擎给后台任务的默认超时是 600 秒，漏掉它的话 watcher 十分钟后就被掐掉
（审计日志里 `watch-stop 0 signal`），而 `--timeout 43200` 那 12 小时一秒都没走到。

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
| `claims.marker` | 有活跃租约时存在；`PreToolUse` 的零成本预检读它。**claim 路径只创建它，绝不删除**；删除只由 `syncMarker` 在拿到写锁之后做（任何一条 bus 命令都会搭车同步一次），所以它既不会在活跃租约下缺失，也不会在租约过期后长期留着 |
| `log.jsonl` | 审计日志，可随时删（含 `pretooluse-no-path`：那次工具调用没抠出任何路径，于是放行了） |

卸载插件后直接删掉整个目录即可，不影响 Kimi Code 本身。

**自定义数据目录时注意**：上面路径里的 `~/.kimi-code` 是缺省值，CLI 与 hook 都按
`KIMI_CODE_HOME` 优先解析。manifest 的预检片段现在也走同一条回退
（`${KIMI_CODE_HOME:-$HOME/.kimi-code}`），但**只在 `KIMI_CODE_HOME` 缺席或为空时才回退**：
两边都设了却设成**不同的值**，预检照样恒假 ⇒ `PreToolUse` 每次静默放行 ⇒ L0 全灭且没有任何
信号（e2e 的 `precheckGate` 把这个前提两边都钉住）。所以要让 hook 环境与 Bash 环境看到同一个
`KIMI_CODE_HOME`。

## 排查

```bash
sqlite3 ~/.kimi-code/agent-bus/bus.db 'select seq, topic, kind, title from posts order by seq desc limit 20'
sqlite3 ~/.kimi-code/agent-bus/bus.db 'select resource, holder_session, lease_until from claims'
```

## 参考

- [Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html) —— `/plugins install`、托管副本、hook 进程拿到的环境变量
- [Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) —— 退出码语义（`0` 放行 / `2` 拦下并把 stderr 作为理由进上下文）
