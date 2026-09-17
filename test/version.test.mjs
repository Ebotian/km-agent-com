import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeVersionError, MIN_NODE_TEXT } from '../lib/version.mjs';

/**
 * I5 的核心是一个**纯函数**，所以投影旧 Node 的代价只是给它一个字符串——不必（也不该）
 * 在测试机上真装一个 22.5.0。真实的"node:sqlite 取不到"由 `cli.test.mjs` 的
 * `--no-experimental-sqlite` 那条用例端到端钉住。
 */

test('nodeVersionError 接受 ≥ 22.13.0', () => {
  for (const v of ['22.13.0', '22.13.1', '22.14.0', '22.20.0', '23.0.0', '24.1.2', '26.8.2', 'v22.13.0']) {
    assert.equal(nodeVersionError(v), null, `${v} 应当通过`);
  }
});

test('nodeVersionError 拒绝 22.5.0–22.12.x（那正是"照文档装完得到静默失效"的区间）', () => {
  for (const v of ['22.5.0', '22.9.3', '22.12.9', '22.0.0', '21.7.0', '20.11.0', '18.20.4']) {
    const err = nodeVersionError(v);
    assert.ok(err, `${v} 必须被判为不满足`);
    assert.match(err, new RegExp(MIN_NODE_TEXT.replace(/\./g, '\\.')), '文案要写出真正的下限');
    assert.match(err, new RegExp(v.replace(/\./g, '\\.')), '文案要回显实际版本，便于自查');
    assert.match(err, /node:sqlite/);
  }
});

test('无法解析的版本串给出明确原因，而不是放行', () => {
  for (const v of ['', 'abc', 'v', 'twenty-two']) {
    const err = nodeVersionError(v);
    assert.ok(err, `${JSON.stringify(v)} 不能被当作"满足"`);
    assert.match(err, new RegExp(MIN_NODE_TEXT.replace(/\./g, '\\.')));
  }
});

test('默认参数取运行时版本（本机必须是通过的那一侧）', () => {
  assert.equal(nodeVersionError(), null, `当前运行时 ${process.versions.node} 应当满足要求`);
});
