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
  /**
   * 現在の expression を PubMed で実際に検索したヒット数（esearch count）。
   * UI で各ブロックに表示している実数をそのまま渡す。null/undefined なら未計測として省略。
   */
  currentHits?: number | null;
  /**
   * 式を構成するキーワード（MeSH / フリーワード）ごとの単体ヒット数と、フリーワードの寄与
   * （Δ・削除候補/低収量区分）。編集画面のインスペクタが計測した実数。空なら省略。
   */
  keywordHits?: KeywordHitContext[];
  /** フリーワードを OR で結合し重複除去した合計（インスペクタの「tiab 合計」）。無ければ省略 */
  freewordDedupTotal?: number | null;
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

/** キーワード 1 語の単体ヒット数 + 寄与情報（プロンプト用）。 */
export interface KeywordHitContext {
  /** 語（MeSH descriptor or フリーワードのテキスト） */
  term: string;
  kind: 'mesh' | 'freeword';
  /** 単体 esearch ヒット数。計測不可なら null */
  hits: number | null;
  /** フリーワードのみ: 個別降順で OR 累積したときの純増（Δ）。MeSH・計測不可は null */
  delta?: number | null;
  /**
   * フリーワードのみ: 寄与区分（normal / lowYield=ほぼ寄与なし / redundant=他語に内包＝削除候補）。
   * MeSH・計測不可は null。
   */
  status?: 'normal' | 'lowYield' | 'redundant' | null;
}

/** improve-block に渡すシード論文 1 件（プロンプト用の最小情報）。 */
export interface SeedPaperContext {
  pmid: string;
  title: string;
  /** include / maybe / initial 等のユーザー判定 */
  decision: string;
  /**
   * この論文に PubMed が付与した MeSH 記述子（チェックタグは除外済みの想定）。
   * どの索引語を式へ補えば seed に当たるかの判断材料。未取得なら空配列。
   */
  meshHeadings?: string[];
  /**
   * アブストラクト抜粋（呼び出し側で冒頭を切り詰め済み）。本文に出る同義語・表記ゆれの根拠。
   * 未取得・抄録なしなら null。
   */
  abstract?: string | null;
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
- シード論文に MeSH 記述子やアブストラクト抜粋が添えられている場合は、それを根拠に
  式を補強する。具体的には、複数の seed に共通して付く MeSH をブロックに足す候補にし、
  アブストラクト本文に現れる表記（同義語・略語・複数形）を tiab 語として補う。
  推測ではなく seed に実在する語を優先する。
- 現在のヒット数が与えられた場合は、それを感度・特異度の判断材料にする。極端に少ない
  （取りこぼしの懸念）なら同義語・表記ゆれ・MeSH で感度を上げ、極端に多い（ノイズ過多）
  なら過度に広い語を絞る。rationale では狙いを件数に触れて説明してよい。
- キーワード別ヒット数が与えられた場合は、0 件の語（綴り・語形ミスの疑い）は修正または
  削除し、ヒットの多すぎる広すぎる語は絞り込みを検討する。逆に主要概念で語が不足していれば
  同義語・MeSH を補う。どの語を足し引きしたかを件数に触れて rationale に書いてよい。
- rationale は日本語 1-2 文で、何をどう変えたか書く。
`.trim();

export const IMPROVE_BLOCK_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

ブロック:
- label: {{LABEL}}
- description: {{DESC}}

現在の expression:
{{CURRENT}}

現在のヒット数（PubMed esearch）: {{HITS}}

キーワード別ヒット数（単体）:
{{KEYWORD_HITS}}

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
    .replace('{{HITS}}', formatHits(input.currentHits))
    .replace('{{KEYWORD_HITS}}', formatKeywordHits(input.keywordHits, input.freewordDedupTotal))
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

/** 現在のヒット数を整形する。未計測（null/undefined）なら「(未計測)」。 */
function formatHits(hits: number | null | undefined): string {
  if (hits === null || hits === undefined) {
    return '(未計測)';
  }
  return `${hits.toLocaleString('en-US')} 件`;
}

/**
 * キーワード別ヒット数を箇条書きへ整形する。空なら「(未計測)」。
 * フリーワードは純増 Δ と区分（削除候補 / ほぼ寄与なし / 0 件）まで注記し、末尾に OR 合計を添える。
 */
function formatKeywordHits(
  keywordHits: KeywordHitContext[] | undefined,
  freewordDedupTotal: number | null | undefined
): string {
  if (!keywordHits || keywordHits.length === 0) {
    return '(未計測)';
  }
  const lines = keywordHits.map((k) => {
    const kindLabel = k.kind === 'mesh' ? 'MeSH' : 'tiab';
    if (k.hits === null) {
      return `- ${k.term} [${kindLabel}]: (未計測)`;
    }
    const parts = [`${k.hits.toLocaleString('en-US')} 件`];
    if (k.delta !== null && k.delta !== undefined) {
      parts.push(`純増Δ +${k.delta.toLocaleString('en-US')}`);
    }
    const notes: string[] = [];
    if (k.hits === 0) {
      notes.push('⚠ 0件（綴り/語形を確認）');
    } else if (k.status === 'redundant') {
      notes.push('⚠ 他語に内包＝削除候補');
    } else if (k.status === 'lowYield') {
      notes.push('△ ほぼ寄与なし');
    }
    const noteStr = notes.length > 0 ? ` ${notes.join(' ')}` : '';
    return `- ${k.term} [${kindLabel}]: ${parts.join('・')}${noteStr}`;
  });
  if (freewordDedupTotal !== null && freewordDedupTotal !== undefined) {
    lines.push(`（フリーワード OR 合計・重複除去後: ${freewordDedupTotal.toLocaleString('en-US')} 件）`);
  }
  return lines.join('\n');
}

/**
 * シード論文リストを箇条書きへ整形する。空なら「(なし)」。
 * MeSH 記述子・アブストラクト抜粋があれば、AI が同義語/索引語を拾えるよう同じ項目内に添える。
 */
function formatSeeds(seeds: SeedPaperContext[] | undefined): string {
  if (!seeds || seeds.length === 0) {
    return '(なし)';
  }
  return seeds
    .map((s) => {
      const lines = [`- PMID ${s.pmid} [${s.decision}]: ${s.title}`];
      if (s.meshHeadings && s.meshHeadings.length > 0) {
        lines.push(`    MeSH: ${s.meshHeadings.join('; ')}`);
      }
      const abstract = s.abstract?.trim();
      if (abstract) {
        lines.push(`    抄録: ${abstract}`);
      }
      return lines.join('\n');
    })
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
