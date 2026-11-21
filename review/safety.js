import { createHash } from 'node:crypto';
export const redact = text => String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]').replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)["']?[^\s"',;]+/gi, '$1[REDACTED]');
export function sanitize(text) { return redact(text).replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '[link removed]').replace(/@/g, '@\u200b').replace(/#(?=\d)/g, '#\u200b').slice(0, 12000); }
export function identity(data, snapshot, config) { return createHash('sha256').update(JSON.stringify([data.repositoryId, data.prNumber, snapshot.base, snapshot.head, config.openai.model, config.review, 'review-v1'])).digest('hex'); }
export function sameSnapshot(pr, snapshot) { return pr.base?.sha === snapshot.base && pr.head?.sha === snapshot.head; }
export function classify(error) {
  if (error.status === 403 && /rate limit|abuse/i.test(error.response?.data?.message || '')) return 'rate_limit';
  if ([401,403,404,422].includes(error.status) && !error.response?.headers?.['retry-after'] && error.response?.headers?.['x-ratelimit-remaining'] !== '0') return 'permanent';
  if (error.status === 429 || error.response?.headers?.['retry-after'] || error.response?.headers?.['x-ratelimit-remaining'] === '0') return 'rate_limit';
  return 'transient';
}
