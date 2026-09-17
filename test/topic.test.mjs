import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopic, topicFromCwd, matches, ALL_TOPIC } from '../lib/topic.mjs';

test('normalizeTopic 统一大小写、折叠斜杠、去首尾斜杠', () => {
  assert.equal(normalizeTopic('Agent-Com/Build'), 'agent-com/build');
  assert.equal(normalizeTopic('//a///b//'), 'a/b');
});

test('normalizeTopic 转义非法字符', () => {
  assert.equal(normalizeTopic('my project'), 'my-project');
  assert.equal(normalizeTopic('a@b#c'), 'a-b-c');
});

test('normalizeTopic 对空输入抛错', () => {
  assert.throws(() => normalizeTopic(''), /空/);
  assert.throws(() => normalizeTopic('///'), /空/);
});

test('topicFromCwd 取 basename 并规范化', () => {
  assert.equal(topicFromCwd('/home/ebt/Downloads/agent-com'), 'agent-com');
  assert.equal(topicFromCwd('/home/ebt/Downloads/my project'), 'my-project');
});

test('topicFromCwd 对根目录抛错', () => {
  assert.throws(() => topicFromCwd('/'), /无法/);
});

test('matches 前缀含子树，且不会把 ab 当成 a 的子树', () => {
  assert.equal(matches('agent-com', 'agent-com'), true);
  assert.equal(matches('agent-com', 'agent-com/build'), true);
  assert.equal(matches('agent-com/build', 'agent-com/build'), true);
  assert.equal(matches('agent-com/build', 'agent-com'), false);
  assert.equal(matches('agent-com', 'agent-comx'), false);
  assert.equal(matches('all', 'agent-com'), false);
});

test('ALL_TOPIC 是 all', () => {
  assert.equal(ALL_TOPIC, 'all');
});
