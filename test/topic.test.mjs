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

test('normalizeTopic 保留 Unicode 字母数字，CJK 不再归空', () => {
  assert.equal(normalizeTopic('项目'), '项目');
});

test('topicFromCwd 保留 CJK 目录名，不再截断', () => {
  assert.equal(topicFromCwd('/home/u/abc项目'), 'abc项目');
});

test('normalizeTopic 保留 slug 语义', () => {
  assert.equal(normalizeTopic('my project'), 'my-project');
});

test('matches 用纯字符串比较：_ 不是单字符通配符', () => {
  assert.equal(matches('a', 'a_b'), false);
});

test('normalizeTopic 把 NFD 与 NFC 归一到同一主题', () => {
  assert.equal(normalizeTopic('e\u0301'), normalizeTopic('\u00e9'));
});

test('normalizeTopic 放行组合附加符号', () => {
  assert.equal(normalizeTopic('हिन्दी'), 'हिन्दी');
});

test('normalizeTopic 仍把 / 当分隔符、% 当可折叠符号', () => {
  assert.equal(normalizeTopic('a/b'), 'a/b');
  assert.equal(normalizeTopic('%20'), '20');
});
