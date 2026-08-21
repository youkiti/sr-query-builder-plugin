import type { ChatMessage, LLMProvider } from '@/lib/llm';
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
  /**
   * この式と掛け合わせる他ブロック（結合行を除く。issue #89）。共有語の有無を問わず全件渡す
   * （sharedTerms は空になりうる）。「#1 と重複するキーワードを消して」のような指示に、
   * 完全一致で機械的に検出できた重複語を根拠として与えるとともに、完全一致しない重複
   * （表記ゆれ・タグ違い・MeSH とフリーワードの対応等）にも式全文から判断する材料を渡す。
   * 空・未計測なら省略（editView 側に兄弟ブロックが存在しない等）。
   */
  siblingBlocks?: SiblingBlockInput[];
  /**
   * 直前までの会話継続（issue #90）。「これは違う、こうして」という追加指示に対応するため、
   * 過去の turn（ユーザーの指示 → LLM の提案）を会話履歴として積む。省略・空配列なら
   * 従来どおり `[system, user]` の単発 2 メッセージ（省略時は現在と完全に同じ挙動）。
   * {@link MAX_IMPROVE_HISTORY_TURNS} を超える場合は新しい方からその件数だけを使う。
   */
  history?: ImproveBlockTurn[];
}

/**
 * improve-block の会話継続（issue #90）で 1 往復ぶんを表す turn。
 * ユーザーの指示と、それに対する LLM の提案（提案 expression + rationale）の組。
 */
export interface ImproveBlockTurn {
  /** その turn でユーザーが入力した指示（空文字なら「おまかせ」） */
  instruction: string;
  /** その turn で LLM が提案した expression */
  proposedExpression: string;
  /** その turn の改善ポイントメモ */
  rationale: string;
}

/**
 * 会話継続として LLM へ渡す history の上限 turn 数（issue #90）。
 * プロンプト肥大化を防ぐため、これを超える古い turn は切り詰める（新しい方を優先して残す）。
 */
export const MAX_IMPROVE_HISTORY_TURNS = 5;

/** 兄弟ブロックとの共有語 1 件（プロンプト用）。SharedTerm（blockInspector.ts）と同じ形（issue #92 B-5）。 */
export interface SharedTermInput {
  term: string;
  kind: 'mesh' | 'freeword';
}

/** improve-block に渡す兄弟ブロック 1 件（プロンプト用）。 */
export interface SiblingBlockInput {
  id: string;
  label: string | null;
  expression: string;
  /**
   * 自分の式と完全一致で共有している語（MeSH descriptor とフリーワード query が混在。
   * kind で種別を区別する）。0 件は「完全一致では見つからなかった」ことを示すだけで、
   * 重複が無いことの証明ではない（blockInspector.ts の computeSiblingOverlaps の doc コメント参照）。
   */
  sharedTerms: SharedTermInput[];
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
- 直前の提案に対する追加の指示がある場合（会話が継続している場合）は、直前の提案を土台に
  修正する（毎回ゼロから作り直さない）。ユーザーが「これは違う」「そうじゃない」と指摘した
  変更は繰り返さない。
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
- 他ブロック（掛け合わせる相手）の式が与えられた場合:
  - 各ブロックに添えた「共有語」は、自分の式との**完全一致**で機械的に検出できたものだけ。
    表記ゆれ・単数複数（child/children）・フィールドタグの違い（[tiab]/[tw]）・
    MeSH とフリーワードの対応関係（"Asthma"[Mesh] と asthma[tiab]）は含まれていない。
    共有語が 0 件でも「重複が無い」ことの証明にはならない。
  - 「重複を消して」「他のブロックと被る語を消して」といった指示に対して削除してよいのは、
    (a) 共有語として明示されている語、または (b) 他ブロックの式全文と照らして明らかに
    同義・表記ゆれの重複だと判断できる語、のうち**ユーザーの指示が指しているもの**だけに限る。
  - 指示から対象を特定できない語を推測で削除してはならない。
- 語を削除するときは、削除した語を rationale に列挙すること。
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

他ブロック（掛け合わせる相手）:
{{SIBLINGS}}

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
  // 会話継続（issue #90）: 新しい方から MAX_IMPROVE_HISTORY_TURNS 件だけを使う。
  // history が空なら以下のロジックは従来と完全に同じ [system, user] 2 メッセージになる。
  const history = (input.history ?? []).slice(-MAX_IMPROVE_HISTORY_TURNS);
  // 文脈テンプレート（RQ・ブロック定義・現式・ヒット数・シード・検証結果等）は必ず 1 度だけ、
  // messages の先頭側の user メッセージに載せる。{{INSTRUCTION}} には「最初に採用する turn の
  // instruction」を入れる（history が空なら今回の userInstruction がその turn そのもの）。
  const firstInstruction = history.length > 0 ? history[0]!.instruction : input.userInstruction;

  const userPrompt = IMPROVE_BLOCK_USER_PROMPT_TEMPLATE.replace('{{RQ}}', input.researchQuestion)
    .replace('{{LABEL}}', input.blockLabel)
    .replace('{{DESC}}', input.blockDescription === '' ? '(不明)' : input.blockDescription)
    .replace('{{CURRENT}}', input.currentExpression)
    .replace('{{HITS}}', formatHits(input.currentHits))
    .replace('{{KEYWORD_HITS}}', formatKeywordHits(input.keywordHits, input.freewordDedupTotal))
    .replace('{{SIBLINGS}}', formatSiblings(input.siblingBlocks))
    .replace('{{SEEDS}}', formatSeeds(input.seedPapers))
    .replace('{{VALIDATION}}', formatValidation(input.validation))
    .replace('{{INSTRUCTION}}', formatInstruction(firstInstruction));

  const messages: ChatMessage[] = [
    { role: 'system', content: IMPROVE_BLOCK_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  // history の各 turn について model（その turn の提案）→ user（次の turn の instruction）を
  // 交互に積む。「次の turn」が history 内に無ければ（＝この turn が history の最後）、
  // 今回の userInstruction を積む。これにより history=[] のときはループが 1 度も回らず、
  // 上の 2 メッセージだけが最終形になる（省略時と完全に同じ挙動）。
  history.forEach((turn, index) => {
    messages.push({
      role: 'model',
      content: JSON.stringify({
        proposed_expression: turn.proposedExpression,
        rationale: turn.rationale,
      }),
    });
    const nextInstruction =
      index + 1 < history.length ? history[index + 1]!.instruction : input.userInstruction;
    messages.push({ role: 'user', content: formatInstruction(nextInstruction) });
  });

  const response = await provider.chat(messages, {
    responseFormat: 'json',
    responseSchema: IMPROVE_BLOCK_SCHEMA,
    temperature: 0.3,
  });
  const raw = parseSkillJson<RawProposal>(response.text, SKILL_NAME);
  return {
    proposedExpression: (raw.proposed_expression ?? '').trim(),
    rationale: raw.rationale ?? '',
  };
}

/** 指示文を整形する。空文字（trim 後）なら「おまかせ」を表すプレースホルダにする。 */
function formatInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  return trimmed === '' ? '(特になし／おまかせで改善してよい)' : trimmed;
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
 * 他ブロック（掛け合わせる相手）を箇条書きへ整形する。空・未指定なら「(渡されていない)」。
 * 各行にブロック ID・ラベル・式全文・共有語を出す（issue #89。重複削除の根拠にするため）。
 * sharedTerms が空の兄弟も出す（共有語は完全一致でしか検出できないため、0 件は「重複が
 * 完全一致では見つからなかった」ことを示すだけで「重複が無い」ことの証明ではない）。
 */
function formatSiblings(siblings: SiblingBlockInput[] | undefined): string {
  if (!siblings || siblings.length === 0) {
    return '(渡されていない)';
  }
  return siblings
    .map((s) => {
      const label = s.label ? ` ${s.label}` : '';
      const shared =
        s.sharedTerms.length > 0
          ? s.sharedTerms.map((t) => t.term).join(', ')
          : '(完全一致の重複なし)';
      return [`- #${s.id}${label}: ${s.expression}`, `    共有語: ${shared}`].join('\n');
    })
    .join('\n');
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
