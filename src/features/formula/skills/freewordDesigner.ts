import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';

/**
 * `freeword-designer` skill — ブロック概念に対する tiab フリーワードを展開する。
 * mesh-suggester の出力（既に MeSH で拾える概念）を踏まえて、
 * MeSH 漏れを補うフリーワードを提案する。
 */

/** freeword 設計の正解コーパスとなる seed 論文サンプル。 */
export interface SeedSample {
  title: string | null;
  abstract: string | null;
}

export interface FreewordDesignerInput {
  conceptSummary: string;
  freewordRequirements: string[];
  /** mesh-suggester の出力。空配列でも可 */
  meshSuggestions: Array<{ descriptor: string }>;
  /** seed 論文のタイトル/抄録サンプル（ti/ab に実際に現れる語の正解コーパス）。空配列でも可 */
  seedSamples?: SeedSample[];
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
- seed 論文のタイトル/抄録が与えられた場合、それは「捕捉すべき論文の ti/ab に実際に現れる表現」の
  正解コーパス。そこに現れる同義語・略語・表記ゆれを優先的に拾う。
  ただし seed は母集団ではないので、seed だけに最適化して一般的な同義語を落とさない。
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

seed 論文のサンプル（ti/ab の正解コーパス）:
{{SEED_SAMPLES}}

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

  const seedSamplesBlock = formatSeedSamples(input.seedSamples ?? []);

  const userPrompt = FREEWORD_DESIGNER_USER_PROMPT_TEMPLATE.replace('{{CONCEPT}}', input.conceptSummary)
    .replace('{{REQUIREMENTS}}', requirementsBlock)
    .replace('{{MESH_LIST}}', meshBlock)
    .replace('{{SEED_SAMPLES}}', seedSamplesBlock);

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

/** 抄録の最大文字数（トークン節約のため超過分は切り詰める）。 */
const ABSTRACT_MAX_CHARS = 1500;

/** seed サンプルをプロンプト用テキストに整形する。タイトル/抄録のどちらも無いサンプルは除く。 */
export function formatSeedSamples(samples: readonly SeedSample[]): string {
  const lines: string[] = [];
  for (const sample of samples) {
    const title = sample.title?.trim();
    const abstract = sample.abstract?.trim();
    if (!title && !abstract) {
      continue;
    }
    lines.push(`- title: ${title || '(なし)'}`);
    if (abstract) {
      const clipped =
        abstract.length > ABSTRACT_MAX_CHARS
          ? `${abstract.slice(0, ABSTRACT_MAX_CHARS)}…`
          : abstract;
      lines.push(`  abstract: ${clipped}`);
    }
  }
  return lines.length === 0 ? '(なし)' : lines.join('\n');
}
