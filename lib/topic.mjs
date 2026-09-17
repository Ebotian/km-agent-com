export const ALL_TOPIC = 'all';

const SEP = '/';

export function normalizeTopic(raw) {
  if (typeof raw !== 'string') throw new Error('主题必须是字符串');
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, '-')
    .split(SEP)
    .map(s => s.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join(SEP);
  if (!cleaned) throw new Error('主题不能为空');
  return cleaned;
}

export function topicFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd 不能为空');
  const base = cwd.replace(/\/+$/, '').split(SEP).pop() ?? '';
  try {
    return normalizeTopic(base);
  } catch {
    throw new Error(`无法从 cwd 推导主题: ${cwd}`);
  }
}

export function matches(pattern, topic) {
  if (pattern === topic) return true;
  return topic.startsWith(pattern + SEP);
}

export function isSubtree() {
  return true;
}
