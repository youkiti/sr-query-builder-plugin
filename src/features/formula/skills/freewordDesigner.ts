import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';

/**
 * `freeword-designer` skill — ブロック概念に対する tiab フリーワードを展開する。
 * mesh-suggester の出力（既に MeSH で拾える概念）を踏まえて、
 * MeSH 漏れを補うフリーワードを提案する。
 */

export interface FreewordDesignerInput {
  conceptSummary: string;
  freewordRequirements: string[];
  /** mesh-suggester の出力。空配列でも可 */
  meshSuggestions: Array<{ descriptor: string }>;
}

export interface FreewordSuggestion {
  /** PubMed クエリ片（例: `"heart failure"[tiab]`） */
  query: string;
  /** 含意・採用根拠（日本語） */
  rationale: string;
}

const SKILL_NAME = 'freeword-designer';

export const FREEWORD_DESIGNER_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
ブロック概念に対する PubMed の tiab フリーワードを設計します。

ルール:
- 対応する MeSH 記述子は既に提案されているので、**MeSH に付与されない新規論文や非定型語彙を拾う** ことを目的にする。
- 1 候補 = 1 PubMed クエリ片（"phrase"[tiab] や word*[tiab] 等）。複数語の同義語は配列で。
- ワイルドカード（*）の使用は語幹が一意のときのみ。曖昧になる場合は完全一致を優先する。
- 近接演算子（[tiab:~N]）は精度が必要な場合のみ。
- 各候補に rationale（日本語、1-2 文）を必ず付ける。
- 出力は JSON のみ。
`.trim();

export const FREEWORD_DESIGNER_USER_PROMPT_TEMPLATE = `
ブロック概念: {{CONCEPT}}

ブロック側のフリーワード要件:
{{REQUIREMENTS}}

既に提案された MeSH:
{{MESH_LIST}}

スキーマ:
{
  "freewords": [
    { "query": "<PubMed クエリ片>", "rationale": "<採用根拠（日本語）>" }
  ]
}
`.trim();

interface RawFreeword {
  freewords?: Array<{ query?: string; rationale?: string }>;
}

export async function designFreewords(
  input: FreewordDesignerInput,
  provider: LLMProvider
): Promise<FreewordSuggestion[]> {
  const requirementsBlock = formatList(input.freewordRequirements);
  const meshBlock = input.meshSuggestions.length === 0
    ? '(MeSH なし)'
    : input.meshSuggestions.map((m) => `- ${m.descriptor}`).join('\n');

  const userPrompt = FREEWORD_DESIGNER_USER_PROMPT_TEMPLATE.replace('{{CONCEPT}}', input.conceptSummary)
    .replace('{{REQUIREMENTS}}', requirementsBlock)
    .replace('{{MESH_LIST}}', meshBlock);

  const response = await provider.chat(
    [
      { role: 'system', content: FREEWORD_DESIGNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', temperature: 0.4 }
  );
  const raw = parseSkillJson<RawFreeword>(response.text, SKILL_NAME);
  return (raw.freewords ?? []).map((f) => ({
    query: f.query ?? '',
    rationale: f.rationale ?? '',
  }));
}

function formatList(items: readonly string[]): string {
  return items.length === 0 ? '(なし)' : items.map((s) => `- ${s}`).join('\n');
}
