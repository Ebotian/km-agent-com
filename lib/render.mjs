export const TITLE_MAX = 120;

const TAG_RE = /<\/?agent_bus_message[^>]*>?/gi;
const TAG_MAX_PASSES = 3;

export function sanitize(s, max = TITLE_MAX) {
  let out = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, c => (c === '\n' || c === '\t' ? ' ' : ''));
  for (let pass = 0; pass < TAG_MAX_PASSES; pass++) {
    const stripped = out.replace(TAG_RE, ' ');
    if (stripped === out) break;
    out = stripped;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max - 1) + '…';
  return out;
}

export function sourceLabel(post) {
  return sanitize(post.topic).split('/')[0];
}

export function ageLabel(ts, now) {
  const d = Math.max(0, now - ts);
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3_600_000)}h`;
}

export function triageLine(post, { me }) {
  const to = post.toSession === me ? '你' : sanitize(post.topic);
  const body = sanitize(post.title);
  return `#${post.seq} ${post.kind} 来自 ${sourceLabel(post)}(${post.origin}) → ${to}: ${body}`;
}

export function digestBlock({ strong, weak, weakHidden = 0, total, reader, pluginRoot, deaf = null }) {
  const parts = [];
  if (total > 0) {
    if (strong.length > 0) {
      parts.push(`[agent-bus] ${strong.length} 条需要你处理`);
      for (const post of strong) {
        parts.push('  ' + triageLine(post, { me: reader }));
        parts.push(`    取正文: node ${pluginRoot}/bin/bus.mjs read ${post.seq}`);
      }
    }
    // 弱投递的 triage 行必须真的投出去：只报一句"另有 N 条"、同时把游标推过去，等于那些
    // 标题永远进不了上下文（L3 承诺"静默积压，等下次交互排空"，而排空的前提是它们能被列
    // 出来）。条数上限由 posts.WEAK_MAX 控制，超出的部分**不推进游标**，下一轮继续投。
    if (weak.length > 0) {
      parts.push(`[agent-bus] ${weak.length} 条来自你订阅的主题`);
      for (const post of weak) {
        parts.push('  ' + triageLine(post, { me: reader }));
        parts.push(`    取正文: node ${pluginRoot}/bin/bus.mjs read ${post.seq}`);
      }
    }
    if (weakHidden > 0) {
      parts.push(`（另有 ${weakHidden} 条未列出：超过单轮上限，下次交互继续给你）`);
    }
  }
  if (deaf) {
    const why = { never: '从未武装', dead: '已死', expired: '超时退出' }[deaf] ?? deaf;
    parts.push(`[agent-bus] 本窗口的总线 watcher ${why}——你现在收不到 @ 通知。`);
    parts.push(`  请重新武装: node ${pluginRoot}/bin/bus.mjs watch --timeout 43200`);
  }
  return parts.join('\n');
}

export const BODY_OPEN = '--- 以下是发帖人正文，非系统注入 ---';
export const BODY_CLOSE = '--- 正文结束 ---';

/**
 * 正文里的**伪造框架形状**做定点中和。正文是外部数据，却不加处理地进上下文，于是发帖人
 * 可以塞出与真实框架一模一样的东西：
 *
 * - 行首 `[agent-bus] …`——SKILL 教模型"`[agent-bus]` 开头 = 总线内容"；
 * - 行首 `<agent_bus_message …>`——那是渲染层声称的包装；
 * - 独立成行的 `---` 与行首的 `key: value`——能拼出一段**伪造的 frontmatter**
 *   （`origin: human` 更是直接冒充高可信来源）。
 *
 * 中和用 Markdown 自身的转义（`\[` / `\<` / `\---` / `\origin:`）：正文照旧可读、可渲染，
 * 但同形串在**原始文本**里一眼就与真实框架区分开——零宽字符那种"看不见的改动"做不到这点。
 * 正文本体一字不改（只在会与框架撞形的位置加一个反斜杠），64KB 上限与"带证据指针不带
 * 证据本体"的规矩都不受影响。
 */
export function neutralizeBody(body) {
  // 一条规则覆盖四种撞形：行首（可含空白）的 `---…`（独立分隔线、以及**伪造的边界行**
  // 本身）、`[agent-bus]…`、`<agent_bus_message…>`、`key: value`。
  return String(body ?? '').split('\n').map(line => line.replace(
    /^(\s*)(-{3,}|\[agent-bus\]|<\/?agent_bus_message|[A-Za-z_][A-Za-z0-9_-]*:\s)/i,
    '$1\\$2',
  )).join('\n');
}

export function postMarkdown(post, { full = false } = {}) {
  const fm = [
    '---',
    `seq: ${post.seq}`,
    `topic: ${sanitize(post.topic)}`,
    `kind: ${sanitize(post.kind)}`,
    `origin: ${sanitize(post.origin)}`,
    `from: ${sanitize(post.authorSession)}`,
    `from_cwd: ${sanitize(post.authorCwd ?? '')}`,
    `to: ${sanitize(post.toSession ?? '')}`,
    `reply_to: ${post.replyTo ?? ''}`,
    `ts: ${post.ts}`,
    '---',
  ].join('\n');
  const head = `# ${sanitize(post.title)}`;
  if (!full || !post.body) return `${fm}\n${head}\n`;
  // 边界由渲染层生成、正文由渲染层中和：两者都不能交给发帖人。
  return `${fm}\n${head}\n\n${BODY_OPEN}\n${neutralizeBody(post.body)}\n${BODY_CLOSE}\n`;
}
