import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
