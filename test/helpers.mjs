import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTmpHome() {
  return mkdtempSync(join(tmpdir(), 'agent-bus-test-'));
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
