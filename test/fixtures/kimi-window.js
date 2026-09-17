/**
 * 一个"假窗口"进程：由用例用
 *
 *     bash -c 'exec -a kimi-code <node> < 本文件'
 *
 * 拉起。它**不是**按路径被 node 执行的——脚本是从 **stdin** 喂进去的，这样 argv 里只剩
 * argv[0]，而 `exec -a` 把 argv[0] 换成 `kimi-code` ⇒ `/proc/<pid>/cmdline` 恰好就是
 * `kimi-code`，与真窗口在 `identity.cmdlineRole` 眼里完全一样。
 *
 * 换成"按路径执行"（`node kimi-window.js`）就不成立：cmdline 会变成
 * `kimi-code /path/to/kimi-window.js`，角色判据立刻落空。也正因为如此，入参只能走环境
 * 变量（argv 让不出位置）：
 *
 * - `FAKE_WINDOW_PIDFILE`：自己的 pid 写这里，用例据此断言 presence 行的 `tui_pid`
 * - `FAKE_WINDOW_CMD`：要用 `shell: true` 拉起的 hook 命令（照抄引擎的形态）
 * - `FAKE_WINDOW_PAYLOAD`：喂给 hook 的 stdin 载荷
 *
 * 它是 CJS（stdin 脚本的默认解析方式），所以用 `require` 而不是 `import`。
 */
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

writeFileSync(process.env.FAKE_WINDOW_PIDFILE, String(process.pid));
const r = spawnSync(process.env.FAKE_WINDOW_CMD, {
  shell: true,
  input: process.env.FAKE_WINDOW_PAYLOAD,
  encoding: 'utf8',
  env: process.env,
});
process.stdout.write(JSON.stringify({
  pid: process.pid, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
}));
