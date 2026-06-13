import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

/**
 * `block-designer` skill — 単一ブロックの概念を MeSH 要件・フリーワード要件に
 * 振り分け、検索式 1 行 (#N) の骨格を設計する。
 * 後続の mesh-suggester / freeword-designer に渡す入力を作る役割。
 */

export interface BlockDesignerInput {
  blockLabel: string;
  description: string;
  researchQuestion: string;
  /** seed 論文のタイトル一覧（概念を実際の研究空間に接地させる）。空配列でも可 */
  seedTitles?: string[];
}

export interface BlockSkeleton {
  /** 概念を要約した英語 1 文（後続 skill のプロンプトで使う） */
  conceptSummary: string;
  /** MeSH 候補生成のヒント（記述子の方向性） */
  meshRequirements: string[];
  /** フリーワード候補生成のヒント（同義語・関連語の方向性） */
  freewordRequirements: string[];
  /** このブロックを検索式 1 行に表現する戦略の自然文メモ（UI 表示用） */
  rationale: string;
}

const SKILL_NAME = 'block-designer';

export const BLOCK_DESIGNER_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
1 つの検索ブロックについて、PubMed 検索式 1 行で表現する骨格を設計します。

ルール:
- MeSH 要件とフリーワード要件を**別々のリスト**で書き出す。
  MeSH は階層を意識した一般的な記述子、フリーワードは tiab で拾う具体語にする。
- seed 論文のタイトルが与えられた場合は、そこに実際に現れる語彙・表記ゆれを要件に反映する。
  ただし seed は「捕捉すべき既知の正例」であって母集団ではないので、seed の語彙に過剰適合して
  概念を狭めない（一般的な同義語・関連語も含める）。
- conceptSummary は英語 1 文、rationale は日本語の戦略メモ。
- 出力は JSON のみ。
`.trim();

export const BLOCK_DESIGNER_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

ブロック:
- label: {{LABEL}}
- description: {{DESC}}

seed 論文のタイトル（既知の正例。語彙の参考にする）:
{{SEED_TITLES}}

スキーマ:
{
  "concept_summary": "<英語 1 文>",
  "mesh_requirements": ["<記述子方向性>"],
  "freeword_requirements": ["<同義語・関連語の方向性>"],
  "rationale": "<検索式 1 行に落とすときの戦略メモ（日本語）>"
}
`.trim();

interface RawBlock {
  concept_summary?: string;
  mesh_requirements?: string[];
  freeword_requirements?: string[];
  rationale?: string;
}

const BLOCK_DESIGNER_SCHEMA = objectSchema({
  concept_summary: stringSchema('英語 1 文の概念要約'),
  mesh_requirements: arraySchema(stringSchema()),
  freeword_requirements: arraySchema(stringSchema()),
  rationale: stringSchema('検索式 1 行に落とす戦略メモ（日本語）'),
});

export async function designBlock(
  input: BlockDesignerInput,
  provider: LLMProvider
): Promise<BlockSkeleton> {
  const seedTitles = input.seedTitles ?? [];
  const seedTitlesBlock =
    seedTitles.length === 0 ? '(なし)' : seedTitles.map((t) => `- ${t}`).join('\n');
  const userPrompt = BLOCK_DESIGNER_USER_PROMPT_TEMPLATE.replace(
    '{{RQ}}',
    input.researchQuestion
  )
    .replace('{{LABEL}}', input.blockLabel)
    .replace('{{DESC}}', input.description)
    .replace('{{SEED_TITLES}}', seedTitlesBlock);

  const response = await provider.chat(
    [
      { role: 'system', content: BLOCK_DESIGNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: BLOCK_DESIGNER_SCHEMA, temperature: 0.3 }
  );
  const raw = parseSkillJson<RawBlock>(response.text, SKILL_NAME);
  return {
    conceptSummary: raw.concept_summary ?? '',
    meshRequirements: raw.mesh_requirements ?? [],
    freewordRequirements: raw.freeword_requirements ?? [],
    rationale: raw.rationale ?? '',
  };
}
