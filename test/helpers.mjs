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
