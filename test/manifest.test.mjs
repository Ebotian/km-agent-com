import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './helpers.mjs';

const manifest = JSON.parse(readFileSync(join(REPO, 'kimi.plugin.json'), 'utf8'));

test('manifest 的 name 是 agent-bus', () => {
  assert.equal(manifest.name, 'agent-bus');
});

test('manifest 声明了 4 个 hook，事件名符合引擎枚举', () => {
  const allowed = new Set(['PreToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit']);
  assert.equal(manifest.hooks.length, 4);
  for (const h of manifest.hooks) assert.ok(allowed.has(h.event), `意外事件 ${h.event}`);
  const events = manifest.hooks.map(h => h.event).sort();
  assert.deepEqual(events, ['PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
});

test('manifest 的 hook 字段严格限定为 event/matcher/command/timeout', () => {
  for (const h of manifest.hooks) {
    for (const k of Object.keys(h)) {
      assert.ok(['event', 'matcher', 'command', 'timeout'].includes(k), `非法字段 ${k}`);
    }
    assert.ok(Number.isInteger(h.timeout) && h.timeout >= 1 && h.timeout <= 600);
  }
});

test('PreToolUse 的 command 带 claims.marker 零成本预检', () => {
  const h = manifest.hooks.find(x => x.event === 'PreToolUse');
  assert.match(h.command, /claims\.marker/);
  assert.match(h.command, /exit 0/);
  assert.match(h.command, /bus-hook\.mjs/);
  assert.match(h.matcher, /Write|Edit|Bash/);
});

/**
 * I2：预检读的 home 必须与 CLI/hook 内部分辨 home 的方式一致（`KIMI_CODE_HOME` 优先、
 * 否则 `~/.kimi-code`）。原来只有 `$KIMI_CODE_HOME` 一支：环境里一旦没有这个变量，预检
 * **恒假** ⇒ 每次工具调用直接 `exit 0` ⇒ L0 全灭，而 claim 照常落在 `~/.kimi-code/agent-bus/`
 * ——一个完全静默的失效（e2e 的 precheckGate 把这个前提两边都钉住）。
 */
test('PreToolUse 的预检在 KIMI_CODE_HOME 缺席时回退到 $HOME/.kimi-code', () => {
  const h = manifest.hooks.find(x => x.event === 'PreToolUse');
  assert.match(h.command, /\$\{KIMI_CODE_HOME:-\$HOME\/\.kimi-code\}/,
    '缺了这条回退，环境里没有 KIMI_CODE_HOME 时预检恒假（L0 静默全灭）');
  assert.match(h.command, /^\s*\[ -f /);
});

test('manifest 引用的路径全部存在且在插件根内', () => {
  for (const rel of [manifest.skills, manifest.commands]) {
    assert.ok(rel.startsWith('./'), `${rel} 必须以 ./ 开头`);
    assert.ok(existsSync(join(REPO, rel)), `${rel} 不存在`);
  }
  assert.ok(existsSync(join(REPO, 'skills/agent-bus/SKILL.md')));
  for (const c of ['peers', 'watch', 'digest']) {
    assert.ok(existsSync(join(REPO, 'commands', `${c}.md`)), `commands/${c}.md 不存在`);
  }
});
