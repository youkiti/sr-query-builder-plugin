import type { LLMProvider } from '@/lib/llm';
import type { OptimizationCriteria } from './optimizeQuery';
import { parseSkillJson } from './parseSkillJson';
import { renderPromptTemplate } from './renderPromptTemplate';
import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema';

export interface AnnotateLostSampleInput {
  criteria: OptimizationCriteria;
  articles: { pmid: string; title: string | null; year: number | null; abstract: string | null; meshHeadings: string[] }[];
}

export interface LostSampleAnnotationItem {
  pmid: string;
  judgement: 'likely_eligible' | 'likely_ineligible' | 'unclear';
  reason: string;
}

const SKILL_NAME = 'annotate-lost-sample';

export const ANNOTATE_LOST_SAMPLE_SYSTEM_PROMPT = `
あなたはシステマティックレビューのスクリーニング補助を行います。
各文献が研究基準に適格らしいかを、タイトル・抄録・MeSH だけから推定してください。
- これは人の判定の参考であり、採否を決めるものではありません。
- 適格らしい場合は likely_eligible、非適格らしい場合は likely_ineligible を選んでください。
- 抄録が無いものや情報不足は unclear とし、確信が無ければ unclear を選んでください。
- reason は日本語の 1 文にしてください。
- 件数の集計は出力せず、指定された PMID ごとの items を JSON だけで返してください。
`.trim();

export const ANNOTATE_LOST_SAMPLE_USER_PROMPT_TEMPLATE = `
研究基準:
{{CRITERIA}}

標本書誌:
{{ARTICLES}}

スキーマ:
{"items": [{"pmid": "<PMID>", "judgement": "likely_eligible | likely_ineligible | unclear", "reason": "<日本語 1 文>"}]}
`.trim();

const ANNOTATE_LOST_SAMPLE_SCHEMA = objectSchema({
  items: arraySchema(objectSchema({
    pmid: stringSchema('標本の PMID'),
    judgement: enumSchema(['likely_eligible', 'likely_ineligible', 'unclear']),
    reason: stringSchema('参考注釈の理由（日本語 1 文）'),
  })),
});

export async function annotateLostSample(input: AnnotateLostSampleInput, provider: LLMProvider): Promise<LostSampleAnnotationItem[]> {
  if (!input.articles.length) return [];
  const prompt = renderPromptTemplate(ANNOTATE_LOST_SAMPLE_USER_PROMPT_TEMPLATE, {
    CRITERIA: JSON.stringify(input.criteria),
    ARTICLES: JSON.stringify(input.articles.map((article) => ({ ...article, abstract: article.abstract?.slice(0, 1500) ?? null }))),
  });
  const response = await provider.chat([
    { role: 'system', content: ANNOTATE_LOST_SAMPLE_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], { responseFormat: 'json', responseSchema: ANNOTATE_LOST_SAMPLE_SCHEMA, temperature: 0.3 });
  const raw = parseSkillJson<{ items?: { pmid?: string; judgement?: string; reason?: string }[] }>(response.text, SKILL_NAME);
  const remaining = new Set(input.articles.map((article) => article.pmid));
  const items: LostSampleAnnotationItem[] = [];
  for (const item of raw.items ?? []) {
    if (!item.pmid || !remaining.delete(item.pmid)) continue;
    items.push({ pmid: item.pmid, judgement: item.judgement === 'likely_eligible' || item.judgement === 'likely_ineligible'
      ? item.judgement : 'unclear', reason: item.reason ?? '' });
  }
  return items;
}
