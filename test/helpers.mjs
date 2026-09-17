import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import * as identity from '../lib/identity.mjs';
import * as posts from '../lib/posts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = dirname(HERE);
export const CLI = join(REPO, 'bin', 'bus.mjs');
export const HOOK = join(REPO, 'hooks', 'bus-hook.mjs');

export function makeTmpHome() {
  return mkdtempSync(join(tmpdir(), 'agent-bus-test-'));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 假 /proc 的固定落点：`<home>/proc`。要交给 runCli 的 procRoot 就是这个值。 */
export function procRootOf(home) {
  return join(home, 'proc');
}

/**
 * `/proc/<pid>/cmdline` 的真实格式是「每个 argv 元素一个 NUL 终止符」，
 * 所以填充时必须整体追加一个 `\0`，而不是逐字符插 NUL（R-I1）。
 */
function writeProcEntry(procRoot, { pid, comm, ppid = 1, cmdline }) {
  const d = join(procRoot, String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0\n`);
  writeFileSync(join(d, 'cmdline'), cmdline + '\0');
}

/** watcher 进程在 /proc 里应有的形状：`node .../bus.mjs watch`（cmdlineRole → 'bus-watch'）。 */
export function watcherCmdline(sessionId) {
  return `node /x/bin/bus.mjs watch --session ${sessionId}`;
}

/**
 * 只种 /proc 的那一半：窗口进程在假 /proc 里的形状（默认就是 kimi-code 窗口）。
 * 夹具**不该**预置 presence 行的场合用它——比如并发注册用例，presence 必须由被测的
 * hook 自己写出来，预置就等于把"注册时的读写间隙"这件事从场景里抹掉了。
 */
export function seedProcEntry(procRoot, { pid, comm = 'kimi-code', ppid = 1, cmdline = 'kimi-code' }) {
  writeProcEntry(procRoot, { pid, comm, ppid, cmdline });
}

/**
 * **成对夹具**：一次调用同时写 `/proc/<pid>/{stat,cmdline}` 与 presence 行。
 *
 * 为什么必须成对：CLI 的公共路径 `ctx()` 里接了 `identity.reapDead`，它拿 procRoot
 * 核对每条 presence 行的 tui_pid 是不是活着的 `kimi-code`。只写 presence 不写假 /proc，
 * 该行会在被测命令刚启动时就被当场清掉——症状是「presence 行凭空消失 → resolveSelf
 * exit 1」，离现场很远，极难自查。两者由同一次调用写出，就不可能脱节。
 *
 * `watcherPid` 可选；给了就同时写它的 `/proc/<pid>/cmdline` 并 `setWatcher`（默认
 * `watcherUntil` 取远期），使「本窗口在听」这个状态同样不可能只落一半。
 *
 * @returns {string} 该 home 的 procRoot（可直接传给 runCli 的 procRoot）
 */
export function seedWindow(home, {
  pid, sessionId, handle, cwd, sessionTitle = '', ppid = 1,
  watcherPid = null, watcherUntil = 9e15, subscribes = [],
}) {
  const procRoot = procRootOf(home);
  writeProcEntry(procRoot, { pid, comm: 'kimi-code', ppid, cmdline: 'kimi-code' });
  if (watcherPid != null) {
    writeProcEntry(procRoot, { pid: watcherPid, comm: 'node', ppid: pid, cmdline: watcherCmdline(sessionId) });
  }
  const db = openDb(join(home, 'agent-bus', 'bus.db'));
  try {
    identity.upsertPresence(db, { tuiPid: pid, sessionId, sessionTitle, cwd, handle });
    if (watcherPid != null) identity.setWatcher(db, { tuiPid: pid, watcherPid, watcherUntil });
    for (const pattern of subscribes) posts.subscribe(db, { reader: sessionId, pattern });
  } finally {
    db.close();
  }
  return procRoot;
}

export function runCli(args, { home, procRoot, input = '', env = {} } = {}) {
  // 缺 home 时不要往下传：env 里的 undefined 会被 Node 丢掉，KIMI_CODE_HOME 于是一整个缺席，
  // CLI 的 kimiHome() 会回落到真实的 ~/.kimi-code——测试绝不能读到/写到开发者的真实家目录。
  if (!home) throw new Error('runCli 需要 home');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      KIMI_CODE_HOME: home,
      KIMI_PLUGIN_ROOT: REPO,
      ...(procRoot ? { AGENT_BUS_PROC_ROOT: procRoot } : {}),
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * hook 的环境。两条都会咬人的规矩：
 * - **缺 home 直接抛错**，与 runCli 同因：`spawnSync` 会丢掉值为 undefined 的 env 键，
 *   `KIMI_CODE_HOME` 一缺席，`kimiHome()` 就回落到开发者真实的 `~/.kimi-code`，
 *   测试会静默读写真实家目录。
 * - `AGENT_BUS_PROC_ROOT` 默认指向**这个 home 里的假 /proc**（`procRootOf(home)`）：
 *   hook 的 `SessionStart` 会调 `identity.reapDead`，它拿 procRoot 核对每条 presence 行的
 *   tui_pid 是不是活着的 kimi-code。若让它落到真实 /proc，夹具里那些假 pid（100…）会被
 *   当场清掉，症状是"刚登记的 presence 行凭空消失"，离现场很远。
 */
function hookEnv({ home, procRoot, pluginRoot = REPO, env = {}, tuiPid = null } = {}) {
  if (!home) throw new Error('runHook 需要 home');
  return {
    ...process.env,
    KIMI_CODE_HOME: home,
    KIMI_PLUGIN_ROOT: pluginRoot,
    AGENT_BUS_PROC_ROOT: procRoot ?? procRootOf(home),
    ...(tuiPid != null ? { AGENT_BUS_TUI_PID: String(tuiPid) } : {}),
    ...env,
  };
}

export function runHook(payload, opts = {}) {
  // 传字符串就原样喂给 stdin（用来测畸形输入），否则序列化
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: hookEnv(opts),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * 并发场景必须用它：`spawnSync` 会把 N 次调用**串行化**，`SessionStart` 之间那道
 * 读-写间隙就永远重现不出来（registerPresence 的整点意义）。
 *
 * `writeStdin`/`closeStdin` 两个开关模拟 stdin 的三种形态（R-T3）：
 * - 默认（都 true）：契约形态，写完就关。
 * - `writeStdin: false, closeStdin: false`：管道**开了但永不送数据也不关**——
 *   钉"hook 自己不会永远挂住"（有界读取）。
 * - `writeStdin: true, closeStdin: false`：载荷送到了但管道不关（万一引擎改用 pty
 *   投递就是这种形态）——钉"载荷照样能读到"，而不是被 isTTY 快路静默丢掉。
 */
export function runHookAsync(payload, opts = {}) {
  const { writeStdin = true, closeStdin = true } = opts;
  const child = spawn(process.execPath, [HOOK], { env: hookEnv(opts) });
  const done = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (writeStdin) child.stdin.write(JSON.stringify(payload));
    if (closeStdin) child.stdin.end();
  });
  // 用例用 deadline 兜底时要能 kill 掉挂住的子进程：只 reject 不 kill 的话，那个进程
  // 会把整份测试文件留在事件循环里（表现是"某条用例失败"变成"整个文件超时"）。
  done.child = child;
  return done;
}
