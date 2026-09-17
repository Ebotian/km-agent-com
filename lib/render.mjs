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

export function digestBlock({ strong, weak, total, reader, pluginRoot, deaf = null }) {
  const parts = [];
  if (total > 0) {
    if (strong.length > 0) {
      parts.push(`[agent-bus] ${strong.length} 条需要你处理`);
      for (const post of strong) {
        parts.push('  ' + triageLine(post, { me: reader }));
        parts.push(`    取正文: node ${pluginRoot}/bin/bus.mjs read ${post.seq}`);
      }
    }
    const weakCount = total - strong.length;
    if (weakCount > 0) parts.push(`（另有 ${weakCount} 条弱投递，随下次对话一起给你）`);
  }
  if (deaf) {
    const why = { never: '从未武装', dead: '已死', expired: '超时退出' }[deaf] ?? deaf;
    parts.push(`[agent-bus] 本窗口的总线 watcher ${why}——你现在收不到 @ 通知。`);
    parts.push(`  请重新武装: node ${pluginRoot}/bin/bus.mjs watch --timeout 43200`);
  }
  return parts.join('\n');
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
  return `${fm}\n${head}\n\n${post.body}\n`;
}
