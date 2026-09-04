import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson, SkillResponseError } from './parseSkillJson';
import { renderPromptTemplate } from './renderPromptTemplate';
import { objectSchema, stringSchema } from './schema';
import type { RecallBlockInput } from './expandQueryForRecall';

/**
 * `design-specific-query` skill — 感度優先で作られた現在の検索式とプロトコルから、
 * **精度（precision）優先の specific な絞り込み式**を 1 本設計する。
 *
 * 用途は #/expand の inside モード（有効 seed 0 件の初期シードブートストラップ。issue #93）。
 * inside モードは従来「現式の内側」から代表例を選んでいたが、現式は感度優先でヒット数が
 * 多く、その上位（既定は最新順）から選ぶだけでは「明確に該当する論文」が母集団に入って
 * いる保証が無い。そこで LLM に精度優先の変種（MeSH は Major Topic、フリーワードはタイトル
 * 限定、同義語の羅列なし）を作らせ、その relevance 上位を母集団にして pick-seed-candidates
 * に渡す。
 *
 * 返り値の query は 1 行の PubMed クエリ（改行・コードフェンスは除去済み）。応答が壊れて
 * いる / query が空 / 括弧が対応していない場合は `SkillResponseError` を投げる（呼び出し側は
 * これを catch して現式へフォールバックできる。API キー欠落や通信エラーはそのまま伝播する）。
 */

export interface DesignSpecificQueryInput {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  /** プロトコルの研究デザイン（例: RCT）。未指定なら空文字 */
  studyDesign?: string;
  /** 現在の検索式の概念ブロック（結合行は除く）。specific 式はこれを AND で絞り込んだ変種にする */
  blocks: RecallBlockInput[];
}

export interface SpecificQueryDesign {
  /** 1 行の PubMed クエリ */
  query: string;
  /** 設計意図（日本語） */
  rationale: string;
}

const SKILL_NAME = 'design-specific-query';

export const DESIGN_SPECIFIC_QUERY_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
感度（recall）優先で作られた現在の PubMed 検索式と研究プロトコルをもとに、**精度（precision）優先の specific な絞り込み式**を 1 本だけ設計します。
これはまだシード論文が 1 件も無い段階で、「組入基準に明確に合致する代表的な論文」を少数だけ確実に拾うための式です。網羅性は不要です。

ルール:
- 現在の検索式の概念ブロック（対象集団・介入・比較・アウトカム等）をすべて AND で結合し、各概念は最も中核的な語だけに絞る。
- MeSH は主題（Major Topic）に限定する: "Descriptor"[Majr]。
- フリーワードはタイトル限定 "phrase"[ti] を基本にし、抄録 [tiab] は中核語だけに使う。
- 同義語・略語・表記ゆれの網羅はしない（感度を上げるための語は入れない）。
- 研究デザインが指定されていれば、対応する Publication Type（例: "Randomized Controlled Trial"[pt]）を AND で加えてよい。
- 日付・言語の制限は付けない。
- 出力は改行を含まない 1 行の PubMed クエリで、ブロックごとに括弧で囲む。
- 出力は JSON のみ。
`.trim();

export const DESIGN_SPECIFIC_QUERY_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

組入基準:
{{INCLUSION}}

除外基準:
{{EXCLUSION}}

研究デザイン: {{STUDY_DESIGN}}

現在の検索式（感度優先）のブロック:
{{BLOCKS}}

スキーマ:
{
  "specific_query": "<改行を含まない 1 行の PubMed クエリ>",
  "rationale": "<どの概念をどう絞ったか（日本語、1〜2 文）>"
}
`.trim();

interface RawResponse {
  specific_query?: string;
  rationale?: string;
}

const DESIGN_SPECIFIC_QUERY_SCHEMA = objectSchema({
  specific_query: stringSchema('精度優先の PubMed クエリ（1 行）'),
  rationale: stringSchema('設計意図（日本語）'),
});

export async function designSpecificQuery(
  input: DesignSpecificQueryInput,
  provider: LLMProvider
): Promise<SpecificQueryDesign> {
  // renderPromptTemplate を使う理由は improveBlock.ts と同じ（issue #92 C-1）。
  const userPrompt = renderPromptTemplate(DESIGN_SPECIFIC_QUERY_USER_PROMPT_TEMPLATE, {
    RQ: input.researchQuestion,
    INCLUSION: input.inclusionCriteria || '(未記載)',
    EXCLUSION: input.exclusionCriteria || '(未記載)',
    STUDY_DESIGN: input.studyDesign?.trim() ? input.studyDesign.trim() : '(未指定)',
    BLOCKS: input.blocks.length === 0 ? '(なし)' : formatBlocks(input.blocks),
  });

  const response = await provider.chat(
    [
      { role: 'system', content: DESIGN_SPECIFIC_QUERY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: DESIGN_SPECIFIC_QUERY_SCHEMA, temperature: 0.2 }
  );
  const raw = parseSkillJson<RawResponse>(response.text, SKILL_NAME);
  const query = normalizeQuery(raw.specific_query);
  if (query === '') {
    throw new SkillResponseError('specific_query が空です', SKILL_NAME, response.text);
  }
  if (!hasBalancedParens(query)) {
    throw new SkillResponseError(
      'specific_query の括弧が対応していません',
      SKILL_NAME,
      response.text
    );
  }
  return { query, rationale: (raw.rationale ?? '').trim() };
}

/**
 * LLM が付けがちなコードフェンス・前後の引用符を剥がし、改行・連続空白を 1 つの空白に潰して
 * 1 行の PubMed クエリにする。
 */
function normalizeQuery(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) {
    text = fenced[1] ?? '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  // 式全体が ` で囲まれている場合だけ剥がす（式中の "phrase" の二重引用符は PubMed 構文なので触らない）
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function hasBalancedParens(query: string): boolean {
  let depth = 0;
  for (const ch of query) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function formatBlocks(blocks: readonly RecallBlockInput[]): string {
  return blocks.map((b) => `#${b.id} ${b.expression}`).join('\n');
}
