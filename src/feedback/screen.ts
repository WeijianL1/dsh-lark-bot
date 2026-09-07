export interface FeedbackEvidence {
  key: string; recordId: string; reason: string; answer?: string; source?: 'conversation'; createdAt?: number;
}
export interface MemoryCandidate { text: string; sources: string[]; supersedes?: string[] }
const explicit = /(?:以后|今后).{0,20}(?:请|要|先|使用|提供|附上|改为|改成)|请记住|我偏好|\bfrom now on\b|\bplease always\b|\balways (?:include|provide|use|start|show|cite)\b|\bremember to\b|\bI prefer\b/i;
const sensitive = /(?:sk-[a-z0-9]{16,}|-----BEGIN|(?:api[_ -]?key|password|密码|密钥|token)\s*[:=]|\b\d{15,19}\b)/i;

/** The model proposes; source binding, support, size and secret checks are code gates. */
export function screenedCandidates(output: string, evidence: FeedbackEvidence[], existingKeys: string[] = []): MemoryCandidate[] {
  const parsed: unknown = JSON.parse(output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!parsed || typeof parsed !== 'object' || !('candidates' in parsed) || !Array.isArray(parsed.candidates)) throw new Error('Invalid screening report');
  const byKey = new Map(evidence.map((item) => [item.key, item]));
  const result: MemoryCandidate[] = [];
  for (const item of parsed.candidates.slice(0, 5)) {
    if (!item || typeof item !== 'object' || !['workflow', 'preference'].includes(item.kind) ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 || sensitive.test(item.text) ||
        !Array.isArray(item.sources) || !item.sources.length || item.sources.some((key: unknown) => typeof key !== 'string' || !byKey.has(key))) continue;
    const sources = [...new Set<string>(item.sources)];
    const support = sources.map((key) => byKey.get(key)!);
    if (support.some((source) => sensitive.test(source.reason))) continue;
    const conversational = support.filter(source => source.source === 'conversation');
    if (conversational.some(source => /这次|本次|暂时|仅这|this time|for now|just for today/i.test(source.reason))) continue;
    if (conversational.some(source => !Array.isArray(item.quotes) || !item.quotes.some((quote: unknown) => typeof quote === 'string' && quote.length >= 4 && source.reason.includes(quote)))) continue;
    if (new Set(support.map((source) => source.recordId)).size < 2 && !support.some((source) => explicit.test(source.reason))) continue;
    const supersedes: string[] = Array.isArray(item.supersedes) ? [...new Set<string>(item.supersedes)] : [];
    if (supersedes.some(key => !existingKeys.includes(key))) continue;
    if (supersedes.length && !support.some(source => explicit.test(source.reason) || /改为|改成|不再|纠正|instead|no longer|actually/i.test(source.reason))) continue;
    result.push({ text: item.text.trim(), sources, ...(supersedes.length ? { supersedes } : {}) });
  }
  return result;
}
