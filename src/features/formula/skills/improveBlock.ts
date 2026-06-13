import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';
import { objectSchema, stringSchema } from './schema';

/**
 * `improve-block` skill — 既存の検索式 1 行 (#N) の PubMed 表現を LLM に再設計させる。
 *
 * requirements.md §4.7 の「行単位で『このブロックを AI に改善させる』ボタン」を実現する
 * ためのモジュール。既存の block-designer / mesh-suggester / freeword-designer を
 * 1 行単位で組み合わせ直すと呼び出し回数が増えるため、軽量な 1 発プロンプトとして独立させた。
 *
 * 入力は現在の expression と、ブロックの意味（label / description）・RQ。
 * 出力は「提案 expression」と「改善ポイント rationale」。ユーザーが diff を見て
 * accept / reject を選ぶ前提で、拡張は破壊的操作を行わない。
 */

export interface ImproveBlockInput {
  /** 現在の 1 行 expression（`#N ...` の N 部分は含まない） */
  currentExpression: string;
  /** ブロックラベル（例: `Population`）。不明なら空文字で良い */
  blockLabel: string;
  /** ブロックの自然言語説明。空文字なら LLM は expression 単体から推定する */
  blockDescription: string;
  /** RQ（あれば文脈として渡す） */
  researchQuestion: string;
  /** ユーザーが任意で書いた改善指示。空文字なら「おまかせ」改善 */
  userInstruction: string;
  /** 捕捉すべきシード論文（include 判定 + 初期登録 + 対話拡張分）。空配列なら省略 */
  seedPapers?: SeedPaperContext[];
  /** 直近の検証で得た捕捉情報。null なら未検証として省略 */
  validation?: ValidationContext | null;
}

/** improve-block に渡すシード論文 1 件（プロンプト用の最小情報）。 */
export interface SeedPaperContext {
  pmid: string;
  title: string;
  /** include / maybe / initial 等のユーザー判定 */
  decision: string;
}

/** 直近の検証捕捉情報。 */
export interface ValidationContext {
  /** 0〜1 */
  captureRate: number;
  capturedPmids: string[];
  /** この式で取りこぼしているシード PMID。改善の主目的 */
  missedPmids: string[];
}

export interface ImproveBlockProposal {
  /** 提案する新しい expression（複数行は `\n` 区切りで入ってくる可能性あり。UI 側でトリム） */
  proposedExpression: string;
  /** 改善ポイントの日本語メモ。ユーザー向け diff 横に表示する */
  rationale: string;
}

const SKILL_NAME = 'improve-block';

export const IMPROVE_BLOCK_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
既存の PubMed 検索式の 1 ブロック（1 行）を、より感度・特異度のバランスが取れた式に改善します。

ルール:
- 出力は JSON のみ。
- proposed_expression は PubMed 検索式として単独で実行できる 1 行。
- 現式が既に十分なら proposed_expression に同じものを返して、rationale に
  「改善余地無し」と書いてよい。
- MeSH / tiab のタグは保持、追加、削除の選択肢を検討する。
- プロトコルに明記されていないフィルタ（English[lang] / Humans[mh] / 年代制限）は
  絶対に付けない（filter-designer の責務）。
- ユーザーからの追加指示がある場合は、上記ルールに反しない範囲で最優先で従う。
- シード論文（捕捉すべき既知の重要論文）が与えられた場合は、それらを取りこぼさない
  ことを重視する。特に「取りこぼし PMID」がある場合は、その論文が引っかかるよう
  同義語・表記ゆれ・MeSH を補って感度を上げる（ただし無関係な語の追加で特異度を
  大きく下げない）。
- rationale は日本語 1-2 文で、何をどう変えたか書く。
`.trim();

export const IMPROVE_BLOCK_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

ブロック:
- label: {{LABEL}}
- description: {{DESC}}

現在の expression:
{{CURRENT}}

シード論文（捕捉すべき既知の重要論文）:
{{SEEDS}}

直近の検証結果:
{{VALIDATION}}

ユーザーからの追加指示:
{{INSTRUCTION}}

スキーマ:
{
  "proposed_expression": "<新しい PubMed 検索式 1 行>",
  "rationale": "<改善点の日本語メモ>"
}
`.trim();

interface RawProposal {
  proposed_expression?: string;
  rationale?: string;
}

const IMPROVE_BLOCK_SCHEMA = objectSchema({
  proposed_expression: stringSchema('新しい PubMed 検索式 1 行'),
  rationale: stringSchema('改善点の日本語メモ'),
});

export async function improveBlockExpression(
  input: ImproveBlockInput,
  provider: LLMProvider
): Promise<ImproveBlockProposal> {
  const userPrompt = IMPROVE_BLOCK_USER_PROMPT_TEMPLATE.replace('{{RQ}}', input.researchQuestion)
    .replace('{{LABEL}}', input.blockLabel)
    .replace('{{DESC}}', input.blockDescription === '' ? '(不明)' : input.blockDescription)
    .replace('{{CURRENT}}', input.currentExpression)
    .replace('{{SEEDS}}', formatSeeds(input.seedPapers))
    .replace('{{VALIDATION}}', formatValidation(input.validation))
    .replace(
      '{{INSTRUCTION}}',
      input.userInstruction.trim() === '' ? '(特になし／おまかせで改善してよい)' : input.userInstruction.trim()
    );

  const response = await provider.chat(
    [
      { role: 'system', content: IMPROVE_BLOCK_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: IMPROVE_BLOCK_SCHEMA, temperature: 0.3 }
  );
  const raw = parseSkillJson<RawProposal>(response.text, SKILL_NAME);
  return {
    proposedExpression: (raw.proposed_expression ?? '').trim(),
    rationale: raw.rationale ?? '',
  };
}

/** シード論文リストを箇条書きへ整形する。空なら「(なし)」。 */
function formatSeeds(seeds: SeedPaperContext[] | undefined): string {
  if (!seeds || seeds.length === 0) {
    return '(なし)';
  }
  return seeds
    .map((s) => `- PMID ${s.pmid} [${s.decision}]: ${s.title}`)
    .join('\n');
}

/** 検証捕捉情報を整形する。null なら「(未検証)」。 */
function formatValidation(validation: ValidationContext | null | undefined): string {
  if (!validation) {
    return '(未検証)';
  }
  const ratePct = Math.round(validation.captureRate * 1000) / 10;
  const missed =
    validation.missedPmids.length === 0
      ? 'なし'
      : validation.missedPmids.join(', ');
  return [
    `捕捉率: ${ratePct}%（${validation.capturedPmids.length}/${
      validation.capturedPmids.length + validation.missedPmids.length
    } 件捕捉）`,
    `取りこぼし PMID: ${missed}`,
  ].join('\n');
}
