import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
