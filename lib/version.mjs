/**
 * Node.js 版本下限，只在这里定义一份。
 *
 * **不是 22.5.0。** `node:sqlite` 在 22.5.0 只是 "Added in"——那时必须带
 * `--experimental-sqlite` 才加载；到 **22.13.0** 才默认可用（无需 flag）。而 manifest 的
 * hook 命令与 e2e 都不带 flag，于是在 22.5.0–22.12.x 上：CLI 每条命令都崩，四个 hook
 * 全部 fail-open（exit 0 放行）⇒ **L0 全灭且没有任何信号**。文档若写 22.5.0，就是
 * "照着文档装完，得到一个静默失效的总线"。
 *
 * 实测（本机 v26.8.2）：`node --no-experimental-sqlite` 下
 * `process.getBuiltinModule('node:sqlite')` 返回 `undefined`，而 `import 'node:sqlite'`
 * 报 `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`——用户看到的就是
 * 这句话，完全无从自查。所以版本探测的文案必须自己说清版本要求。
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;
export const MIN_NODE_TEXT = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`;

/**
 * @param {string} version 默认取运行时的 `process.versions.node`（测试可注入）
 * @returns {string|null} 不满足时给出**可自查**的中文原因，满足时 null
 */
export function nodeVersionError(version = process.versions.node) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) {
    return `无法解析 Node 版本 "${version}"；agent-bus 需要 Node.js ≥ ${MIN_NODE_TEXT}（内建 node:sqlite）。`;
  }
  const [major, minor] = m.slice(1, 3).map(Number);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) return null;
  return `agent-bus 需要 Node.js ≥ ${MIN_NODE_TEXT}，当前 ${version}：`
    + `内建 node:sqlite 从 ${MIN_NODE_TEXT} 起默认可用，在 22.5.0–22.12.x 仍需 --experimental-sqlite，`
    + '而本插件的 hook 命令不带这个 flag。请升级 Node 后重试。';
}
