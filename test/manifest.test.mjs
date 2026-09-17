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
