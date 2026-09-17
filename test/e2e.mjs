#!/usr/bin/env node
/**
 * Task 12 的端到端脚本：在**临时 home** 里把整条链路真跑一遍。
 *
 * 不进 `node --test test/` 的原因：这里要开真实后台进程（`bus watch`）并等它被 `@` 唤醒退出，
 * 而 `node --test` 的用例共用同一个事件循环与进程，夹具会互相踩。
 *
 * 全链路：窗口登记 → L0 在访问点上拦住跨窗口的资源争用 → `@` 秒级唤醒空闲窗口 →
 * 读消息并回复 → 任务被原子认领（互斥）→ 完结。外加两条本任务裁决要求钉住的东西：
 * 并发注册（R-H3）与 PreToolUse 零成本预检的环境前提（R-V6）。
 *
 * **任何一次 CLI/hook/shell 调用都用临时 home**：`KIMI_CODE_HOME` 与 `HOME` 一起指过去，
 * 即使哪条路径漏了前者，`identity.kimiHome()` 的回落也只落到临时目录。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, 'bin', 'bus.mjs');
const HOOK = join(REPO, 'hooks', 'bus-hook.mjs');
// 预检片段不抄写：逐字取 manifest 里那一行（抄写会漂移，而"逐字"正是这条要证明的前提）
const PRECHECK = JSON.parse(readFileSync(join(REPO, 'kimi.plugin.json'), 'utf8'))
  .hooks.find(h => h.event === 'PreToolUse').command;

const TMP = [];

function newHome(tag) {
  const home = mkdtempSync(join(tmpdir(), `agent-bus-e2e-${tag}-`));
  TMP.push(home);
  return { home, procRoot: join(home, 'proc') };
}

function cleanupAll() {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
}

/**
 * 子进程环境。三条都不能省：
 * - `KIMI_CODE_HOME`：CLI/hook 的 `identity.kimiHome()` 优先读它——**所有**调用都必须
 *   指向临时 home，绝不能碰开发者真实的 `~/.kimi-code`；
 * - `HOME`：万一哪条路径漏了上面那个变量，`homedir()` 回落也只落到临时目录；
 * - `AGENT_BUS_PROC_ROOT`：CLI 的 `ctx()` 与 hook 的 `SessionStart` 都会顺带 `reapDead`，
 *   拿 procRoot 核对每条 presence 行的 tui_pid 是不是活着的 `kimi-code`。夹具用的假 pid
 *   在真实 /proc 里不存在，只写 presence 不配套假 /proc 的话，**刚登记的行会被当场清掉**
 *   （症状是 `peers` 报 0 个窗口，离现场很远）。所以每个 home 都配一个假 /proc。
 */
function envOf({ home, procRoot }, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    KIMI_CODE_HOME: home,
    KIMI_PLUGIN_ROOT: REPO,
    AGENT_BUS_PROC_ROOT: procRoot,
    ...extra,
  };
}

/** 窗口进程在假 /proc 里的形状（`cmdlineRole` → 'kimi-code'），与 presence 行必须成对。 */
function seedWindowProc({ procRoot }, pid) {
  const d = join(procRoot, String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'stat'), `${pid} (kimi-code) S 1 1 1 0 -1 0 0 0\n`);
  writeFileSync(join(d, 'cmdline'), 'kimi-code\0');
}

function cli(args, { home, procRoot, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: envOf({ home, procRoot }),
  });
  if (!allowFail && r.status !== 0) {
    throw new Error(`CLI ${args.join(' ')} 退出 ${r.status}: ${r.stderr}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hook(event, payload, { home, procRoot, tuiPid = null } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, ...payload }),
    encoding: 'utf8',
    env: envOf({ home, procRoot }, tuiPid == null ? {} : { AGENT_BUS_TUI_PID: String(tuiPid) }),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 并发场景必须用它：`spawnSync` 会把 N 次调用串行化，读-写间隙就永远重现不出来。 */
function hookAsync(event, payload, { home, procRoot, tuiPid = null } = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: envOf({ home, procRoot }, tuiPid == null ? {} : { AGENT_BUS_TUI_PID: String(tuiPid) }),
  });
  child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** 按引擎的方式跑 manifest 的 shell 片段（`sh -c`，载荷从 stdin 喂进去）。 */
function runShell(command, { home, procRoot, extraEnv = {}, input = null } = {}) {
  const r = spawnSync('/bin/sh', ['-c', command], {
    input,
    encoding: 'utf8',
    env: envOf({ home, procRoot }, extraEnv),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * 直接读库核对状态。刻意不走 `bus` 命令：CLI 的输出是**被测对象**，拿它验它自己会
 * 把"写对了但读错了"这类问题一起吞掉。读用 node 内建的 `node:sqlite`，零依赖。
 */
function query({ home }, sql) {
  const db = new DatabaseSync(join(home, 'agent-bus', 'bus.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const A_SESSION = 'session_aaaa-0001';
const B_SESSION = 'session_bbbb-0002';
const C_SESSION = 'session_cccc-0003';
const A_PID = 90001;
const B_PID = 90002;
const C_PID = 90003;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let watcher = null;

async function main() {
  const flow = newHome('flow');
  console.log(`临时 home: ${flow.home}`);
  console.log(`（真实 ~/.kimi-code 全程未被触碰：所有子进程的 HOME 与 KIMI_CODE_HOME 都指向临时目录）`);

  // 1. 两个窗口登记
  seedWindowProc(flow, A_PID);
  seedWindowProc(flow, B_PID);
  hook('SessionStart', { session_id: A_SESSION, cwd: '/p/agent-com', session_title: 'A' }, { ...flow, tuiPid: A_PID });
  hook('SessionStart', { session_id: B_SESSION, cwd: '/p/other', session_title: 'B' }, { ...flow, tuiPid: B_PID });
  const peers = JSON.parse(cli(['peers', '--json', '--tui-pid', String(A_PID)], flow).stdout);
  assert(peers.peers.length === 2, `应有 2 个窗口，实际 ${peers.peers.length}`);
  const handles = peers.peers.map(p => p.handle).sort();
  assert(handles.join(',') === 'agent-com,other', `handle 应由 cwd 推出，实际 ${handles.join('、')}`);
  console.log(`✓ 两个窗口登记成功（handle: ${handles.join('、')}）`);

  // 2. A 认领资源，B 在访问点上被拦住（L0）
  cli(['claim', '/p/agent-com/data.db', '--ttl', '1h', '--tui-pid', String(A_PID)], flow);
  const blocked = hook('PreToolUse', {
    session_id: B_SESSION, cwd: '/p/other',
    tool_name: 'Bash', tool_input: { command: 'sqlite3 /p/agent-com/data.db "pragma user_version"' },
  }, { ...flow, tuiPid: B_PID });
  assert(blocked.status === 2, `PreToolUse 应拒绝，实际退出 ${blocked.status}`);
  assert(/agent-com/.test(blocked.stderr), 'stderr 应点出持有者');
  assert(blocked.stderr.includes(A_SESSION), 'stderr 应点名持有者的 session（B 得知道去找谁）');
  console.log('✓ L0 访问点拦截生效：B 碰 A 认领的文件 ⇒ 工具调用被拒（退出 2）');

  // 3. B 订阅 agent-com，然后武装 watcher
  cli(['subscribe', 'agent-com', '--tui-pid', String(B_PID)], flow);
  watcher = spawn(process.execPath, [CLI, 'watch', '--tui-pid', String(B_PID), '--interval', '50'],
    { env: envOf(flow) });
  let watcherOut = '';
  watcher.stdout.on('data', d => { watcherOut += d; });
  await sleep(400);

  // 4. A 点名 B → B 的 watcher 应秒级退出
  const postedAt = Date.now();
  cli(['post', '--topic', 'agent-com', '--kind', 'request', '--to', 'other',
    '--title', '帮忙跑 pytest', '--body', '见 lib/db.mjs:88', '--tui-pid', String(A_PID)], flow);

  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('watcher 未在 5s 内被唤醒')), 5000);
    watcher.on('exit', c => { clearTimeout(t); resolve(c); });
  });
  const wokeMs = Date.now() - postedAt;
  assert(code === 0, `watcher 应退出 0，实际 ${code}`);
  // stdout 契约（见 skill）：命中时必有 JSON 行；"到期/信号"也是 exit 0 但 stdout 为空
  assert(watcherOut.trim() !== '', 'watcher 退出了 0 但 stdout 是空的——按契约那是"到期/信号"，不是命中');
  const payload = JSON.parse(watcherOut.trim().split('\n').pop());
  assert(payload.strong.length === 1, '应有一条点名消息');
  assert(payload.strong[0].seq === 1, `点名消息应是 #1，实际 #${payload.strong[0].seq}`);
  console.log(`✓ @B 在 ${wokeMs}ms 内唤醒了空闲窗口（${payload.strong[0].title}）`);

  // 5. B 读消息并回复
  const read = cli(['read', '1', '--full', '--tui-pid', String(B_PID)], flow);
  assert(/lib\/db\.mjs:88/.test(read.stdout), 'read --full 应带出正文');
  cli(['post', '--topic', 'agent-com', '--kind', 'finding', '--to', 'agent-com',
    '--reply-to', '1', '--title', 'pytest 全绿', '--tui-pid', String(B_PID)], flow);
  const replied = query(flow, 'SELECT to_session FROM posts WHERE reply_to = 1')[0];
  assert(replied?.to_session === A_SESSION, `回复应落在 A 身上，实际 ${replied?.to_session}`);
  console.log('✓ B 读消息（正文到手）并回复给 A');

  // 6. 工作队列：A 发任务，两个窗口抢，只有一个拿到
  cli(['post', '--topic', 'agent-com', '--kind', 'request', '--title', '谁来跑迁移',
    '--tui-pid', String(A_PID)], flow);
  const open = JSON.parse(cli(['tasks', '--json', '--tui-pid', String(A_PID)], flow).stdout);
  // 步骤 4 那条 @request 没有认领人，所以开放列表里本来就该有两条：它 + 刚发的这条。
  // （brief 这一步字面写的是 1；跑出来是 2。按标题取本次那条，才抢的是"刚发的任务"。）
  assert(open.tasks.length === 2,
    `应有 2 个开放任务（步骤 4 未认领的 request + 本次），实际 ${open.tasks.length}`);
  const mine = open.tasks.find(t => t.post.title === '谁来跑迁移');
  assert(mine, `刚发的任务应在开放列表里，实际 ${open.tasks.map(t => t.post.title).join('、')}`);
  const taskSeq = mine.post.seq;

  // 第三窗口 C 去抢 B 已持有的那个任务。**必须换一个 session**：`claims.claim` 的
  // `ON CONFLICT ... WHERE` 有 `claims.holder_session = :holder` 这个析取项，明确允许
  // 持有者续租自己——同一个 session 再抢一次是**成功**的（brief 的字面版实测 status 0），
  // 那样断出来的不是互斥语义。
  seedWindowProc(flow, C_PID);
  hook('SessionStart', { session_id: C_SESSION, cwd: '/p/third', session_title: 'C' }, { ...flow, tuiPid: C_PID });
  const three = JSON.parse(cli(['peers', '--json', '--tui-pid', String(A_PID)], flow).stdout);
  assert(three.peers.length === 3, `C 登记后应有 3 个窗口，实际 ${three.peers.length}`);

  const won = cli(['claim', `task:${taskSeq}`, '--tui-pid', String(B_PID)], { ...flow, allowFail: true });
  assert(won.status === 0, `B 的认领应成功，实际退出 ${won.status}: ${won.stderr}`);
  const lost = cli(['claim', `task:${taskSeq}`, '--tui-pid', String(C_PID)], { ...flow, allowFail: true });
  assert(lost.status === 2, `C 的认领应被拒（退出 2），实际退出 ${lost.status}`);
  assert(/other/.test(lost.stderr), `冲突文案应点出持有者 B 的 handle，实际: ${lost.stderr.trim()}`);
  // 失败的那次认领绝不能改掉持有者：认领成功与否就看 SQL 影响了几行
  const held = query(flow, `SELECT holder_session FROM claims WHERE resource = 'task:${taskSeq}'`)[0];
  assert(held?.holder_session === B_SESSION, `持有者应仍是 B，实际 ${held?.holder_session}`);
  console.log('✓ 原子认领：C 抢 B 已持有的任务被拒（退出 2），持有者不变');

  // 7. done 之后任务不再开放
  cli(['done', String(taskSeq), '--result', '已跑完', '--tui-pid', String(B_PID)], flow);
  const after = JSON.parse(cli(['tasks', '--json', '--tui-pid', String(A_PID)], flow).stdout);
  // 完结的那条消失，步骤 4 那条未认领的 request 仍在（brief 字面写 0；跑出来是 1）。
  assert(!after.tasks.some(t => t.post.seq === taskSeq), '完结的任务不应还在开放列表');
  assert(after.tasks.length === 1,
    `完结后应只剩步骤 4 那条，实际 ${after.tasks.length}：${after.tasks.map(t => t.post.title).join('、')}`);
  const done = query(flow, `SELECT completed_at FROM claims WHERE resource = 'task:${taskSeq}'`)[0];
  assert(done?.completed_at != null, 'done 应把 completed_at 落库');
  console.log('✓ 任务完结后从开放列表消失，且 completed_at 落库（不复活）');

  await concurrentRegistration();
  sessionSwitch();
  precheckGate();

  console.log('\nE2E OK');
}

/**
 * R-H3：并发注册的钉子。Task 5 的复审实测：把 `registerPresence` 里的
 * `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 整段删掉，仓库里的用例**仍全绿**——并发证据只存在于
 * 一次性探针里。强度全在"真并发"上：必须真开 N 个进程，`spawnSync` 会把它们串行化，
 * 读-写间隙就永远重现不出来。
 *
 * 基线（Task 5 复审）：旧的两步流程（算 handle / 写 presence 分开）在 8 并发下 **6/6 次
 * 撞名、8 行只剩 2 个不同 handle**；`registerPresence` 是 **6/6 次互不相同**。
 */
async function concurrentRegistration() {
  // 一轮 6 并发的漏检率实测约 1/5（把 `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 删掉的变异实验：
  // 5 次跑出 4 次撞名），所以同一个场景在**各自全新的 home** 上跑 3 轮——断言不变，只是
  // 多给几次重现"读-写间隙"的机会。
  const ROUNDS = 3;
  for (let round = 1; round <= ROUNDS; round++) {
    const c = newHome(`concurrent-${round}`);
    const pids = [70101, 70102, 70103, 70104, 70105, 70106];
    // 只种 /proc 那一半：presence 必须由被测的 hook 自己写出来，预置就等于把"注册时的
    // 读写间隙"这件事从场景里抹掉了。
    for (const pid of pids) seedWindowProc(c, pid);
    const rs = await Promise.all(pids.map(pid => hookAsync(
      'SessionStart',
      { session_id: `session_con_${round}_${pid}`, cwd: '/p/same-room', session_title: 'C' },
      { ...c, tuiPid: pid },
    )));
    assert(rs.every(r => r.status === 0), `第 ${round} 轮有进程没登记成功: ${rs.map(r => r.stderr).join('|')}`);

    const rows = query(c, 'SELECT tui_pid, handle FROM presence ORDER BY tui_pid');
    const hs = rows.map(r => r.handle);
    assert(rows.length === 6, `第 ${round} 轮应登记 6 行，实际 ${rows.length}（${hs.join('、')}）`);
    assert(new Set(hs).size === 6, `第 ${round} 轮 6 个窗口的 handle 必须互不相同，实际 ${hs.join('、')}`);
  }
  console.log(`✓ ${ROUNDS} 轮 × 6 进程并发注册同一 cwd：每轮 6 行、handle 互不相同`);
}

/**
 * R-E5：`/new` 的动作顺序是「先 start 新会话、**后** end 旧会话」——`SessionEnd` 只按 pid 删
 * 的话，删掉的正是新会话刚写好的那一行，于是**凡走过 `/new` 的窗口都登记不上**（换会话、
 * 清上下文都会走它，是最日常的路径）。生产现场就是这么坏的：`log.jsonl` 里
 * `start(new)` → `end(old)` 交错，而 `presence` 0 行、`subs` 2 行。
 *
 * 这里用真 hook + 真 CLI 跑一遍那个交错，并顺手钉住"载荷缺 `session_id` 的 end 只留审计、
 * 不删行"。断言全部读库核对（CLI 的输出是被测对象，不拿它验它自己），只在最后用一次
 * `whoami` 看用户可见形态。
 */
function sessionSwitch() {
  const h = newHome('new');
  const pid = 90021;
  const OLD_S = 'session_swold-0001';
  const NEW_S = 'session_swnew-0002';
  seedWindowProc(h, pid);
  hook('SessionStart', { session_id: OLD_S, cwd: '/p/agent-com', session_title: '旧' }, { ...h, tuiPid: pid });
  assert(query(h, 'SELECT session_id FROM presence').length === 1, '前置：旧会话已登记');

  // /new 的真实顺序：先 start 新会话（同一 pid 上覆盖），后 end 旧会话
  hook('SessionStart', { session_id: NEW_S, cwd: '/p/agent-com', session_title: '新' }, { ...h, tuiPid: pid });
  hook('SessionEnd', { session_id: OLD_S, cwd: '/p/agent-com' }, { ...h, tuiPid: pid });

  const rows = query(h, 'SELECT tui_pid, session_id, handle FROM presence');
  assert(rows.length === 1 && rows[0].session_id === NEW_S,
    `走过 /new 的窗口必须仍登记着新会话，实际 ${JSON.stringify(rows)}`);
  const me = JSON.parse(cli(['whoami', '--json', '--tui-pid', String(pid)], h).stdout);
  assert(me.sessionId === NEW_S, `whoami 应认出新会话，实际 ${me.sessionId}`);

  // 载荷缺 session_id 的 end：跳过删除（宁可留陈旧行，也不删别人的行），并留一行审计
  hook('SessionEnd', { cwd: '/p/agent-com' }, { ...h, tuiPid: pid });
  const kept = query(h, 'SELECT session_id FROM presence');
  assert(kept.length === 1 && kept[0].session_id === NEW_S, '缺 session_id 的 end 不许删任何行');
  const logged = JSON.parse(cli(['log', '--json', '--limit', '10', '--home', h.home], h).stdout);
  assert(logged.some(e => e.action === 'session-end-missing-session'), '跳过删除必须留痕（否则现场无痕）');

  console.log('✓ /new 交错（start(new) → end(old)）后窗口仍登记着新会话；缺 session_id 的 end 只留审计不删行');
}

/** 一个只记录自己被调用的 `node` 桩：用来直接观察预检有没有进入 `exec node` 分支。 */
function makeNodeShim(dir) {
  const shimDir = join(dir, 'shim');
  const log = join(dir, 'shim.log');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'node'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SHIM_LOG"\nexit 0\n', { mode: 0o755 });
  return { dir: shimDir, log };
}

/**
 * R-V6：钉住一条**被依赖的环境前提**。
 *
 * manifest 的 PreToolUse 用 `[ -f "$KIMI_CODE_HOME/agent-bus/claims.marker" ] || exit 0` 做零成本
 * 预检，而 CLI/hook 内部走 `identity.kimiHome()`（`KIMI_CODE_HOME` 优先、否则 `~/.kimi-code`）。
 * 两者若不一致，预检**恒假** ⇒ 每次工具调用都直接 `exit 0` ⇒ **L0 全灭**，而 `claim` 照常
 * 落在 `~/.kimi-code/agent-bus/`——一个完全静默的失效。所以这里逐字取 manifest 那一行真跑，
 * 并分别证明「预检为真时会进入 `exec node` 分支」与「不一致时不会」。
 */
function precheckGate() {
  const h = newHome('precheck');
  const other = newHome('precheck-other'); // 只用来做"两个 home 不一致"的阴性对照
  const A = { pid: 90011, session: 'session_pre-0001', cwd: '/p/agent-com' };
  const B = { pid: 90012, session: 'session_pre-0002', cwd: '/p/other' };
  seedWindowProc(h, A.pid);
  seedWindowProc(h, B.pid);
  hook('SessionStart', { session_id: A.session, cwd: A.cwd, session_title: 'A' }, { ...h, tuiPid: A.pid });
  hook('SessionStart', { session_id: B.session, cwd: B.cwd, session_title: 'B' }, { ...h, tuiPid: B.pid });

  const marker = join(h.home, 'agent-bus', 'claims.marker');
  assert(!existsSync(marker), '还没有租约时不该有 claims.marker');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: B.session, cwd: B.cwd, tool_name: 'Bash',
    tool_input: { command: `sqlite3 ${A.cwd}/data.db "pragma user_version"` },
  });
  const shim = makeNodeShim(h.home);
  const probe = (home) => runShell(PRECHECK, {
    home, procRoot: h.procRoot, input: payload,
    extraEnv: { PATH: `${shim.dir}:${process.env.PATH}`, SHIM_LOG: shim.log },
  });

  // (a) 没有租约：预检为假 ⇒ 连 node 都不启动（这就是"零成本"）
  const idle = probe(h.home);
  assert(idle.status === 0, `无租约时预检应放行，实际退出 ${idle.status}`);
  assert(!existsSync(shim.log), '没有 marker 时 node 不该被启动');

  // (b) A 认领 ⇒ marker 落在 $KIMI_CODE_HOME/agent-bus/ 下
  cli(['claim', `${A.cwd}/data.db`, '--ttl', '1h', '--tui-pid', String(A.pid)], h);
  assert(existsSync(marker), `claim 后应建出 ${marker}`);

  // (c) 同一片段这次进了 `exec node` 分支：真跑一个 hook，它现在拦得住 B 的工具调用
  const armed = runShell(PRECHECK, { home: h.home, procRoot: h.procRoot, input: payload });
  assert(armed.status === 2, `有租约时应放行给 hook 并拦下（退出 2），实际退出 ${armed.status}`);
  assert(armed.stderr.includes(A.session), '拦截原因（含持有者）应进 B 的上下文');
  probe(h.home);
  assert(existsSync(shim.log) && /bus-hook\.mjs/.test(readFileSync(shim.log, 'utf8')),
    'marker 存在时 manifest 那一行必须进入 exec node 分支');

  // (d) 阴性对照：marker 在 h.home，而预检读的是另一个 KIMI_CODE_HOME ⇒ 预检恒假 ⇒
  // 即使资源真被占着也直接放行。**这就是那条前提断掉之后的现场：没有任何信号。**
  rmSync(shim.log, { force: true });
  const mismatched = probe(other.home);
  assert(mismatched.status === 0, '预检读错 home 时必然放行');
  assert(!existsSync(shim.log), '预检读错 home 时 node 从未被启动——L0 在这种情形下是静默失效的');

  // (f) I2：KIMI_CODE_HOME **缺席**（空）时必须回退到 `$HOME/.kimi-code`。环境里没有这个
  // 变量是常见形态（引擎只往 hook 进程里注入它），而 CLI 侧的 `identity.kimiHome()` 是
  // "KIMI_CODE_HOME 优先、否则 ~/.kimi-code"——预检没有同一条回退就恒假：每次工具调用直接
  // exit 0，而 claim 照常落在 ~/.kimi-code/agent-bus/，全程无信号。
  // 这里必须造出 `$HOME` 与 `$HOME/.kimi-code` 的真关系：默认 home 是 `~/.kimi-code` 本身，
  // 所以单独用一个"$HOME = 临时目录"的窗口对，marker 落在 `<HOME>/.kimi-code/agent-bus/`。
  const dh = newHome('precheck-defhome');
  const dhKimi = join(dh.home, '.kimi-code');
  seedWindowProc(dh, A.pid);
  seedWindowProc(dh, B.pid);
  hook('SessionStart', { session_id: A.session, cwd: A.cwd, session_title: 'A' }, { ...dh, home: dhKimi, tuiPid: A.pid });
  hook('SessionStart', { session_id: B.session, cwd: B.cwd, session_title: 'B' }, { ...dh, home: dhKimi, tuiPid: B.pid });
  cli(['claim', `${A.cwd}/data.db`, '--ttl', '1h', '--tui-pid', String(A.pid)], { ...dh, home: dhKimi });
  assert(existsSync(join(dhKimi, 'agent-bus', 'claims.marker')), `默认 home 下的 marker 该在 ${dhKimi}`);

  const viaHomeEnv = { home: dh.home, procRoot: dh.procRoot, input: payload };
  const noHomeVar = runShell(PRECHECK, { ...viaHomeEnv, extraEnv: { KIMI_CODE_HOME: '' } });
  assert(noHomeVar.status === 2,
    `KIMI_CODE_HOME 缺席时应由 $HOME 回退找到 marker 并拦下调用，实际退出 ${noHomeVar.status}`);
  assert(noHomeVar.stderr.includes(A.session), '回退之后拦下时同样要带上持有者');
  rmSync(shim.log, { force: true });
  runShell(PRECHECK, {
    ...viaHomeEnv,
    extraEnv: { KIMI_CODE_HOME: '', PATH: `${shim.dir}:${process.env.PATH}`, SHIM_LOG: shim.log },
  });
  assert(existsSync(shim.log) && /bus-hook\.mjs/.test(readFileSync(shim.log, 'utf8')),
    'KIMI_CODE_HOME 缺席时也必须进入 exec node 分支（预检不是恒假）');

  // (e) 释放 ⇒ marker 消失 ⇒ 预检重新为假：门是活的，跟着租约生命周期开关
  cli(['release', `${A.cwd}/data.db`, '--tui-pid', String(A.pid)], h);
  assert(!existsSync(marker), '释放后不该再有 claims.marker');
  assert(probe(h.home).status === 0, '释放后预检应直接放行');

  console.log('✓ 预检门：claim ⇒ marker 出现 ⇒ 那一行进入 exec node 分支并拦住调用；release ⇒ marker 消失');
  console.log('✓ 阴性对照：KIMI_CODE_HOME 与 marker 所在 home 不一致时预检恒假（L0 静默失效）');
  console.log('✓ KIMI_CODE_HOME 缺席时回退到 $HOME/.kimi-code，预检仍然为真');
}

main()
  .then(() => {
    if (watcher) watcher.kill('SIGKILL');
    cleanupAll();
    process.exit(0);
  })
  .catch(err => {
    if (watcher) watcher.kill('SIGKILL');
    console.error('\nE2E 失败:', err.message);
    cleanupAll();
    process.exit(1);
  });
