import { blockDiagnosisLines, type BlockDiagnosis } from '@/features/validation/blockDiagnosis';
import type { LLMProvider } from '@/lib/llm';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { renderPromptTemplate } from './renderPromptTemplate';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema';

export interface OptimizationCriteria {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
}

export interface ApprovedOptimizationBlock {
  id: string;
  approvedBlockId: string;
  label: string;
}

/** シード × ブロックの捕捉表。ブロックごとに 1 通信で測る。 */
export interface OptimizationSeedCapture {
  /** run のシードと同じ順。 */
  seedPmids: string[];
  rows: { blockId: string; capturedPmids: string[] | null; error: string | null }[];
}

/** 未捕捉シードの書誌。抄録は先頭 1500 文字まで。 */
export interface OptimizationMissedSeed {
  pmid: string;
  title: string | null;
  year: number | null;
  hasAbstract: boolean;
  abstract: string | null;
  meshHeadings: string[];
  note: string | null;
}

/** 未捕捉シードの診断。未測定は null とし、年だけで原因を決めない。 */
export interface OptimizationSeedDiagnosis {
  pmid: string;
  title: string | null;
  year: number | null;
  hasAbstract: boolean;
  meshHeadingCount: number | null;
  blockingBlockIds: string[] | null;
  recoverableByTerms: boolean | null;
  note: string;
}

export interface OptimizationMeasurement {
  seedCapture?: OptimizationSeedCapture;
  id: string;
  fingerprint: string;
  measuredAt: string;
  totalHits: number | null;
  capturedPmids: string[] | null;
  missedPmids: string[] | null;
  blocks: { id: string; hits: number | null; error: string | null }[];
  terms?: { blockId: string; query: string; hits: number | null; delta: number | null; finalContribution?: number | null }[];
}

export interface OptimizationMeshNode {
  id: string;
  descriptor: string;
  label: string | null;
  treeNumbers: string[];
  parentIds: string[];
  childIds: string[];
  explode: boolean;
  /** 取得済み範囲の限界・失敗・未解決も明示する。 */
  note: string;
}

export interface OptimizationMeshRequest {
  /** 展開したい descriptor。tree number だけで指定するときは空文字。 */
  descriptor: string;
  /** 展開したい枝。descriptor だけで指定するときは空文字。 */
  treeNumber: string;
}

export interface OptimizationMeshRequestResult {
  request: OptimizationMeshRequest;
  /** 未取得の理由も日本語で明示し、ノードや親子関係とは分けて渡す。 */
  note: string;
}

export interface OptimizationImpact {
  /** 失う集合の標本に対する AI の参考注釈。採否・ゲート・状態区分には使わない。 */
  annotation?: {
    status: 'success' | 'failure';
    /** ISO 8601 */
    annotatedAt: string;
    /** 注釈を依頼した PMID（書誌を取得できた標本） */
    requestedPmids: string[];
    items: { pmid: string; judgement: 'likely_eligible' | 'likely_ineligible' | 'unclear'; reason: string }[];
    /** 失敗時の理由。成功時は null */
    error: string | null;
  };
  /** 失敗した通信を区別する。未指定の旧記録は error を使って保守的に判定する。 */
  failedMeasurements?: ('lost_search' | 'lost_fetch' | 'gained_search')[];
  /** 変更前 NOT 変更後 の実測件数。失敗時は null（未測定を 0 件として扱わない）。 */
  lostHits: number | null;
  /** 変更後 NOT 変更前 の実測件数。失敗時は null。 */
  gainedHits: number | null;
  sample?: {
    method: 'all' | 'retrieved_subset';
    /** 抽出に使った乱数の種（32bit 符号なし整数）。 */
    seed: number;
    /** 差集合の実測件数（lostHits と同じ値）。 */
    populationCount: number;
    /** 取得できた PMID の件数（重複除去後）。 */
    retrievedCount: number;
    /** 抽出した PMID（数値昇順）。efetch に失敗しても残す。 */
    pmids: string[];
    /** ISO 8601 の抽出時刻。 */
    sampledAt: string;
  };
  /** 抽出した PMID の書誌（sample のない旧データは先頭の数件）。集合全体を安全と判断する根拠にはしない。 */
  inspected: { pmid: string; title: string | null; year: number | null }[];
  /** 実測・書誌取得の失敗理由。成功時は null。 */
  error: string | null;
}

export interface OptimizationTrial {
  duplicateOf?: string;
  /** 提案前の最良式と候補式を、ブロックごとの検索語の集合で比べた差分。 */
  formulaDiff?: { blockId: string; added: string[]; removed: string[] }[];
  /** 採用判定を通ったが削除影響の確認が必要なため、レビュー候補として保留した試行。 */
  held?: boolean;
  /** 採用判定の直前に実測した差集合。判定前に却下した試行には無い。 */
  impact?: OptimizationImpact;
  kind: 'initial' | 'proposal' | 'information' | 'final' | 'finish';
  /** 変更案の生成時は必須。MeSH の変更語も run の文脈への参照として使う。 */
  changes?: Pick<OptimizeQueryProposal, 'targetBlockId' | 'addedTerms' | 'removedTerms' | 'replacedTerms'>;
  /** 情報要求の対象だけを保持し、ノード本体は run の文脈から引く。 */
  meshRequests?: OptimizationMeshRequest[];
  /** request_context で trial_detail_ids を指定した情報要求にだけ設定する（kind: 'information'）。 */
  trialDetailIds?: string[];
  /** kind が finish のときの区分。変更不要か、語の変更では解決できず人の判断が必要か。 */
  finishKind?: OptimizeQueryFinishKind;
  /**
   * 既知シードを全件捕捉したまま目安件数を超えている間の no_change_needed 終了判断を
   * 制御側が受け付けなかったときの理由。設定時、この finish 試行は accepted: false のまま
   * 改善なし回数へ数え、停止せずに次の AI 呼び出しへ進む（kind: 'finish' のみで設定）。
   */
  finishRejectedReason?: string;
  /**
   * AI の応答が行動種別の必須・排他条件を満たさなかった（action: 'invalid'）ときの理由。
   * 式は最良式のまま変更していないため、再開時の「過去の run の却下記録」（実際に却下された変更案）
   * には含めないよう、この印で区別する。
   */
  responseError?: string;
  /** 情報要求の件数と、取得に成功して文脈へ反映できた要求の件数。 */
  informationResult?: { requested: number; obtained: number };
  /** 直前の情報要求で得た文脈を読んだうえでの判断。次の候補評価にだけ設定する。 */
  informedBy?: {
    /** 元になった情報要求の試行 ID。 */
    candidateId: string;
    /** 要求した件数。 */
    requested: number;
    /** 文脈へ反映できた要求の件数。0 なら新しい文脈は得られていない。 */
    obtained: number;
  };
  apiEvents: OptimizationApiEvent[];
  candidateId: string;
  formula: PubmedFormula;
  accepted: boolean;
  reason: string;
  rationale: string;
  before: OptimizationMeasurement | null;
  after: OptimizationMeasurement | null;
}

export interface OptimizationApiEvent {
  status: 'rate_limit' | 'retry' | 'failure';
  source: 'PubMed' | 'MeSH' | 'AI';
}

/** 過去の run の却下記録。今回の測定 ID・実測値として参照してはいけない。 */
export interface PreviousOptimizationRejection {
  formula: PubmedFormula;
  reason: string;
  fingerprint: string | null;
  /**
   * 最終レビューで人が「除外」を選んだ判断か。true は人が失う集合を見て受け入れないと
   * 判断したことを示し、未指定（旧形式含む）は AI による却下・保留として扱う。
   */
  rejectedByHuman?: boolean;
}

/**
 * request_context の trial_detail_ids で取り出した、個別試行の全式・前後の実測・削除影響。
 * 見つからない・上限超過の ID は formula 以降を持たず、note に理由だけを残す。
 */
export interface OptimizeQueryTrialDetailResult {
  candidateId: string;
  /** 取り出せなかった理由。取得できたときは null。 */
  note: string | null;
  formula?: PubmedFormula;
  before?: OptimizationMeasurement | null;
  after?: OptimizationMeasurement | null;
  /** annotation を除く。参考注釈は採否に使わないため詳細にも含めない。 */
  impact?: Omit<OptimizationImpact, 'annotation'>;
  reason?: string;
  rationale?: string;
}

export interface OptimizeQueryInput {
  blockDiagnosis?: BlockDiagnosis;
  missedSeeds?: OptimizationMissedSeed[];
  formula: PubmedFormula;
  approvedBlocks: ApprovedOptimizationBlock[];
  criteria: OptimizationCriteria;
  maxHits: number;
  measurement?: OptimizationMeasurement;
  seedPapers?: { pmid: string; title: string | null }[];
  meshContext?: OptimizationMeshNode[];
  meshRequestResults?: OptimizationMeshRequestResult[];
  trials?: OptimizationTrial[];
  /** 直前の情報要求で取り出した試行詳細。次の 1 回の呼び出しにだけ渡す。 */
  trialDetails?: OptimizeQueryTrialDetailResult[];
  previousRejectedTrials?: PreviousOptimizationRejection[];
}

export interface OptimizeQueryProposal {
  targetBlockId: string;
  proposedExpression: string;
  addedTerms: string[];
  removedTerms: string[];
  replacedTerms: { before: string; after: string }[];
  rationale: string;
  measurementIds: string[];
}

/** finish の区分。変更不要か、語の変更では解決できず人の判断が必要か。 */
export type OptimizeQueryFinishKind = 'no_change_needed' | 'needs_human_judgment';

/**
 * optimize_query の応答を行動種別で判別した結果。
 * - request_context: MeSH の追加取得だけを求め、式は変えない
 * - propose_changes: 1 ブロックの変更案
 * - finish: 変更を出さずに終える判断（変更不要 / 人の判断が必要）
 * - invalid: 上記いずれの必須・排他条件も満たさない応答（例外にせず値として返す）
 */
export type OptimizeQueryDecision =
  | ({ action: 'request_context' } & Pick<OptimizeQueryProposal, 'rationale' | 'measurementIds'>
      & { meshRequests: OptimizationMeshRequest[]; trialDetailIds: string[] })
  | ({ action: 'propose_changes' } & OptimizeQueryProposal)
  | ({ action: 'finish'; finishKind: OptimizeQueryFinishKind } & Pick<OptimizeQueryProposal, 'rationale' | 'measurementIds'>)
  | { action: 'invalid'; reason: string; rationale: string };

const SKILL_NAME = 'optimize-query';

/**
 * 情報要求（action: request_context）は反復上限（評価試行数）を消費しないため、無限に続かないよう
 * run 単位で別に制限する。app 層（queryOptimizationService.ts）はここから import して re-export する
 * （features 層から app 層を import しないため、この向きが正しい）。
 */
export const MAX_INFORMATION_TRIALS = 3;

/**
 * request_context の trial_detail_ids で 1 回に取り出せる試行詳細の上限。
 * 超えた分・run に無い ID は取り出さず、理由を注記する（queryOptimizationService.ts が実装する）。
 */
export const MAX_TRIAL_DETAILS_PER_REQUEST = 3;

/** TRIALS 要約に載せる rationale の上限文字数。全文は trial_detail_ids で取り出す。 */
const TRIAL_SUMMARY_RATIONALE_LIMIT = 200;

export const OPTIMIZE_QUERY_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。研究基準と全式の結合構造を踏まえて、
action を 1 つ選び、JSON だけで返してください。
- 試行履歴（TRIALS）は要約だけを渡します。全式・変更前後の全測定（語別件数を含む）を確認したい試行が
  あれば、request_context の trial_detail_ids に candidateId を指定してください（1 回 ${MAX_TRIAL_DETAILS_PER_REQUEST} 件まで）。
  取り出した詳細は次の 1 回の判断にだけ渡ります。取得は通信を発生させませんが、情報要求の予算
  （run あたり ${MAX_INFORMATION_TRIALS} 回）は mesh_requests と同じ枠を消費します。
- action は request_context・propose_changes・finish のいずれかです。他の値は使えません。
  - request_context: MeSH の周辺文脈の追加取得、または過去の試行の詳細取得のどちらか、もしくは
    両方を求めるときに選びます。mesh_requests・trial_detail_ids の少なくとも一方を 1 件以上指定し、
    proposed_expression は空文字、added_terms・removed_terms・replaced_terms は空配列にします。
    この回は式を変更せず、追加取得の結果を次の反復で読んでから改めて判断します。
    情報要求は run あたり ${MAX_INFORMATION_TRIALS} 回までです。上限に達すると以降の要求は取得されません。
  - propose_changes: 承認済み概念ブロック 1 件の変更案を返すときに選びます。target_block_id・
    proposed_expression を必須とし、mesh_requests・trial_detail_ids は空配列にします。
  - finish: 変更を出さずに終える判断です。初期式が目標内でも冗長語・低寄与語・シード漏れを分析し、
    修正要否を判断してください。finish_kind に no_change_needed（分析の結果、修正不要と判断した）か
    needs_human_judgment（承認外のブロックや結合構造が落としているなど、語の変更では解決できず
    人の判断が必要）のどちらかを指定し、rationale に理由を書きます。mesh_requests・trial_detail_ids・
    added_terms・removed_terms・replaced_terms は空配列にします。target_block_id・proposed_expression の値は
    無視されるため、何を入れても構いません。finish しても目安件数・既知シードの捕捉を満たしたことには
    ならず、達成の判定は制御側の最終実測で決まります。
    既知シードを全件捕捉したまま目安件数を超えている間は no_change_needed を受け付けません。
    件数を減らす候補（語の削除より、特異的な語との AND・下位 MeSH への置換など失う集合を小さく保つ
    狭め方）を propose_changes で出してください。失う集合がある候補は保留候補として人の判断に回るので、
    それ自体は失敗ではありません。needs_human_judgment は、語の変更では解決できない場合
    （承認外のブロックや結合構造が落としている等）に限ります。
- ID の追加・削除・変更、結合行と研究デザインフィルタの変更は禁止です。
- proposed_expression はタグ付き検索語と AND/OR/NOT・括弧で構成する単一行です。
  他ブロック参照、PMID 指定、研究基準にない期間・言語・対象集団の制限を追加しません。
  AND / NOT と OR を同じ階層に混ぜるときは必ず括弧で囲んでください（PubMed は左から評価するため、
  括弧のない混在は意図と違う集合になり、測定前に却下されます）。ブロック構造の診断で優先順位の
  混在を指摘されたブロックは、まず括弧で囲む変更を検討してください。
- 捕捉済みシードを維持し、漏れがあれば回収を優先します。全件捕捉後に件数を減らす変更は失う集合が出るため自動採用されず、
  人が判断する保留候補になります（1 run で 3 件そろうと終了）。保留候補は互いに異なる狭め方にし、
  何を失う見込みかを rationale に書いてください。検索集合を変えない削除（冗長整理）は、
  差集合で失う 0 件・増える 0 件を実測できたときだけ自動採用されます。
- 未計測・失敗は不明であり 0 件ではありません。単独件数と累積 OR の純増 Δ は
  最終式での固有寄与とは異なります。少数でも必要な概念やシードを拾う語は保持します。
- 冗長・低寄与を削除の確証とせず、変更案全体を制御側が再実測します。
- 未捕捉シードがある間は削除案を出しません。捕捉表で落としているブロックと未捕捉書誌の
  語・MeSH を照らし、そのブロックへの同義語追加・MeSH 拡張を優先します。
  抄録の無い文献は索引語（MeSH・タイトル語）から考えます。承認外のブロック
  （研究デザインフィルタ）や結合構造が落としている場合は、語の変更では回収できないことを
  rationale に書き、finish（needs_human_judgment）を選びます。
- 変更前に当たって変更後に当たらない文献（失う集合）が 1 件でもある変更案は自動採用されず保留になります。
  削除・置換を提案するときは、失う集合が 0 件になる冗長整理か、
  失う理由を rationale で説明できる変更に限ってください。
- ブロック構造の診断で効いていない、または重なりありとされたブロックは、語の削除よりも
  特異的な語との AND・下位の MeSH への置換を優先して検討してください。
  重なりは、上位語でしか索引されない適格文献を拾うために必要な場合もあります。
  失う集合が出る狭め方は保留になります。研究デザインフィルタは変更しません。
- MeSH は提供された実在ノードと親子関係を根拠にし、未取得の関係を推測しません。
  NoExp・qualifier・MajorTopic の変更は別の操作として理由を示します。
- 周辺の外を調べる必要があれば request_context を選び、mesh_requests に descriptor / tree_number を
  指定します。少なくとも片方を指定し、不要なら空配列を返します。要求は優先順に並べてください。
  取得は 1 反復 3 件までです。未取得・失敗・打ち切りの説明を読み、関係を推測しません。
- 却下理由と前後の実測を読み、同じ失敗を繰り返しません。
  「保留・却下した変更の一覧」の各行には対象ブロックの変更後の式を載せます。
  「このブロック以外は現在の式と同じ」とある行の式を同じブロックに再び出すと同一式となり、
  測定せずに却下されて改善なしに数えられます（差集合の測定失敗時は再測定できます）。
  保留になった変更は、失う集合とともにすでに人の判断に回っています。同じ式を再提案しても
  新しい保留候補にはならないので出さないでください。保留候補を増やしたいときは、一覧のどの式とも異なる狭め方を出してください。
  一覧の削除を同じ形で出しても、失う集合が残る限り再び保留になります。
  件数を減らしたいときは、語を削る代わりにブロックの語を特異的な語と AND で組み合わせる、
  下位の MeSH に置き換える、といった狭める案を検討してください。採否は実測で決まります。
- 過去の run の却下記録のうち rejectedByHuman が true のものは、人が失う集合を見て
  明示的に受け入れないと判断した変更です。同じ式を再度提案しても測定せずに却下されるため、
  別の変更を検討してください。
- rationale は日本語で研究基準との意味的整合性の検討結果を含めます。
  これは AI の判断であって機械的な保証ではありません。
- 件数の予想は出力しません。measurement_ids には実際に参照した測定 ID だけを返します。
`.trim();

export const OPTIMIZE_QUERY_USER_PROMPT_TEMPLATE = `
研究基準:
{{CRITERIA}}
目安件数（最終式の件数の目安。適格文献を落としてまで合わせない）: {{MAX_HITS}}
現在の全式（ID・式・結合構造）:
{{FORMULA}}
承認済みブロックとの対応（対応のないブロックと結合行は変更禁止）:
{{APPROVED}}
測定スナップショット（Δ はフリーワード累積 OR の純増）:
{{MEASUREMENT}}
シード書誌:
{{SEEDS}}
シード × ブロック捕捉表:
{{SEED_CAPTURE}}
未捕捉シードの書誌:
{{MISSED_SEEDS}}
ブロック構造の診断（機械的な検出。AI の判断ではない）:
{{BLOCK_DIAGNOSIS}}
周辺 MeSH ツリー（親子・全 tree number・explode/NoExp）:
{{MESH}}
MeSH 追加取得要求の結果（未取得理由を含む）:
{{MESH_REQUEST_RESULTS}}
保留・却下した変更の一覧:
{{REJECTED_CHANGES}}
試行履歴（要約。採否・却下理由・前後件数のみ。全式・全測定は request_context の trial_detail_ids で取り出せます）:
{{TRIALS}}
要求した試行の詳細（前回の情報要求で取得。この 1 回の判断にだけ使えます）:
{{TRIAL_DETAILS}}
過去の run の却下記録（未再検証。今回の実測ではなく、同じ失敗を避けるための文脈）:
{{PREVIOUS_REJECTIONS}}
スキーマ:
{
  "action": "<request_context | propose_changes | finish>",
  "target_block_id": "<propose_changes のときの変更対象 ID。他の action では無視されます>",
  "proposed_expression": "<propose_changes のときの変更後の式。他の action では空文字>",
  "added_terms": ["<propose_changes のときの追加語。他の action では空配列>"],
  "removed_terms": ["<propose_changes のときの削除語。他の action では空配列>"],
  "replaced_terms": [{"before": "<置換前>", "after": "<置換後>"}],
  "finish_kind": "<finish のときは no_change_needed または needs_human_judgment。他の action では not_applicable>",
  "rationale": "<日本語の変更理由・終了理由>",
  "measurement_ids": ["<参照した測定 ID>"],
  "mesh_requests": [{"descriptor": "<展開対象の descriptor>", "tree_number": "<展開対象の枝。未指定なら空文字>"}],
  "trial_detail_ids": ["<全式・全測定を確認したい試行の candidateId。1 回 3 件まで。他の action では空配列>"]
}
`.trim();

interface RawOptimizationProposal {
  action?: string;
  target_block_id?: string;
  proposed_expression?: string;
  added_terms?: string[];
  removed_terms?: string[];
  replaced_terms?: { before?: string; after?: string }[];
  finish_kind?: string;
  rationale?: string;
  measurement_ids?: string[];
  mesh_requests?: { descriptor?: string; tree_number?: string }[];
  trial_detail_ids?: string[];
}

const OPTIMIZE_QUERY_ACTIONS = ['request_context', 'propose_changes', 'finish'] as const;
const OPTIMIZE_QUERY_FINISH_KINDS = ['no_change_needed', 'needs_human_judgment'] as const;

const OPTIMIZE_QUERY_SCHEMA = objectSchema({
  action: enumSchema(OPTIMIZE_QUERY_ACTIONS, '選んだ行動種別'),
  target_block_id: stringSchema('承認済み概念ブロックの ID（propose_changes 以外は無視）'),
  proposed_expression: stringSchema('変更後の単一行の式（propose_changes 以外は空文字）'),
  added_terms: arraySchema(stringSchema()),
  removed_terms: arraySchema(stringSchema()),
  replaced_terms: arraySchema(objectSchema({ before: stringSchema(), after: stringSchema() })),
  finish_kind: enumSchema(['not_applicable', ...OPTIMIZE_QUERY_FINISH_KINDS], 'finish のときだけ意味を持つ区分'),
  rationale: stringSchema('日本語の変更理由・終了理由'),
  measurement_ids: arraySchema(stringSchema()),
  mesh_requests: arraySchema(objectSchema({
    descriptor: stringSchema('展開対象の descriptor。tree number だけで指定するときは空文字'),
    tree_number: stringSchema('展開対象の tree number。descriptor だけで指定するときは空文字'),
  })),
  trial_detail_ids: arraySchema(stringSchema('全式・全測定を確認したい試行の candidateId（request_context 以外は空配列）')),
});

export async function optimizeQuery(
  input: OptimizeQueryInput,
  provider: LLMProvider
): Promise<OptimizeQueryDecision> {
  const prompt = renderPromptTemplate(OPTIMIZE_QUERY_USER_PROMPT_TEMPLATE, {
    CRITERIA: formatContext(input.criteria),
    MAX_HITS: String(input.maxHits),
    FORMULA: formatContext(input.formula),
    APPROVED: formatContext(input.approvedBlocks),
    MEASUREMENT: input.measurement ? formatMeasurement(input.measurement) : '(未計測)',
    SEEDS: formatContext(input.seedPapers),
    SEED_CAPTURE: input.measurement?.seedCapture ? input.measurement.seedCapture.rows.map((row) =>
      row.capturedPmids === null ? `#${row.blockId}: 未測定（${row.error}）`
        : `#${row.blockId}: 捕捉 [${row.capturedPmids.join(', ')}] / 未捕捉 [${input.measurement!.seedCapture!.seedPmids.filter((pmid) => !row.capturedPmids!.includes(pmid)).join(', ')}]`
    ).join('\n') : '(未計測)',
    MISSED_SEEDS: formatContext(input.missedSeeds),
    BLOCK_DIAGNOSIS: input.blockDiagnosis ? blockDiagnosisLines(input.blockDiagnosis).join('\n') || '検出された重なり・件数診断はありません' : '(未診断)',
    MESH: formatContext(input.meshContext),
    MESH_REQUEST_RESULTS: formatContext(input.meshRequestResults),
    PREVIOUS_REJECTIONS: formatContext(input.previousRejectedTrials ?? []),
    REJECTED_CHANGES: formatRejectedChanges(input.trials ?? [], input.formula),
    TRIALS: summarizeTrials(input.trials ?? []),
    TRIAL_DETAILS: formatTrialDetails(input.trialDetails),
  });
  const response = await provider.chat([
    { role: 'system', content: OPTIMIZE_QUERY_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], { responseFormat: 'json', responseSchema: OPTIMIZE_QUERY_SCHEMA, temperature: 0.3 });
  const raw = parseSkillJson<RawOptimizationProposal>(response.text, SKILL_NAME);
  const targetBlockId = (raw.target_block_id ?? '').trim();
  const proposedExpression = (raw.proposed_expression ?? '').trim();
  const addedTerms = raw.added_terms ?? [];
  const removedTerms = raw.removed_terms ?? [];
  const replacedTerms = (raw.replaced_terms ?? []).map((term) => ({ before: term.before ?? '', after: term.after ?? '' }));
  const rationale = raw.rationale ?? '';
  const measurementIds = raw.measurement_ids ?? [];
  const meshRequests = (raw.mesh_requests ?? []).map((request) => ({
    descriptor: (request.descriptor ?? '').trim(), treeNumber: (request.tree_number ?? '').trim(),
  }));
  const trialDetailIds = (raw.trial_detail_ids ?? []).map((id) => (id ?? '').trim()).filter((id) => id !== '');
  const hasProposedExpression = proposedExpression !== '';
  const hasTermChanges = addedTerms.length > 0 || removedTerms.length > 0 || replacedTerms.length > 0;
  const invalid = (reason: string): OptimizeQueryDecision => ({ action: 'invalid', reason, rationale });

  // action の無い旧形式は、mesh_requests の有無だけで判別していた従来の解釈を保つ
  // （replay fixture・デモ・E2E スタブが旧形式のため、書き換えずに動くこと）。旧形式に
  // trial_detail_ids は存在しなかったため、常に空配列として扱う。
  if (raw.action === undefined) {
    return meshRequests.length > 0
      ? { action: 'request_context', meshRequests, trialDetailIds: [], rationale, measurementIds }
      : { action: 'propose_changes', targetBlockId, proposedExpression, addedTerms, removedTerms, replacedTerms, rationale, measurementIds };
  }
  if (raw.action === 'request_context') {
    if (hasProposedExpression || hasTermChanges) return invalid('変更案と情報要求が混在しています');
    if (meshRequests.length === 0 && trialDetailIds.length === 0) return invalid('情報要求ですが mesh_requests と trial_detail_ids のどちらもありません');
    return { action: 'request_context', meshRequests, trialDetailIds, rationale, measurementIds };
  }
  if (raw.action === 'propose_changes') {
    if (meshRequests.length > 0 || trialDetailIds.length > 0) return invalid('変更案と情報要求が混在しています');
    if (!targetBlockId || !proposedExpression) return invalid('変更案に target_block_id または proposed_expression がありません');
    return { action: 'propose_changes', targetBlockId, proposedExpression, addedTerms, removedTerms, replacedTerms, rationale, measurementIds };
  }
  if (raw.action === 'finish') {
    if (meshRequests.length > 0 || trialDetailIds.length > 0 || hasTermChanges) return invalid('終了判断に変更内容が混在しています');
    if (raw.finish_kind !== 'no_change_needed' && raw.finish_kind !== 'needs_human_judgment') return invalid('finish_kind がありません');
    if (!rationale) return invalid('終了理由（rationale）がありません');
    return { action: 'finish', finishKind: raw.finish_kind, rationale, measurementIds };
  }
  return invalid(`不明な action です: ${raw.action}`);
}

/** 欠測の数値や捕捉一覧は実測 0・空集合に補完しない。 */
function formatMeasurement(measurement: OptimizationMeasurement): string {
  return JSON.stringify({ ...measurement, terms: measurement.terms ?? '(未計測)' },
    (key, value: unknown) => value === null ? (key === 'error' ? '(なし)' : '(未計測)') : value, 2);
}

function formatContext(value: unknown): string {
  if (value === undefined) return '(渡されていない)';
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null) return '(渡されていない)';
    if (item === '' || (Array.isArray(item) && item.length === 0)) return '(なし)';
    return item;
  }, 2);
}

/** 語一覧を先頭 10 語 + 省略件数に切り詰める。0 件は「なし」。 */
function formatTermList(terms: string[]): string {
  return terms.length ? terms.slice(0, 10).join(', ') + (terms.length > 10 ? `、ほか ${terms.length - 10} 語` : '') : 'なし';
}

/** formulaDiff をブロックごとの「削除: ... / 追加: ...」に整形する。記録の有無を区別する。 */
function formatFormulaDiff(formulaDiff: OptimizationTrial['formulaDiff']): string {
  const diff = formulaDiff?.map((block) =>
    `#${block.blockId} 削除: ${formatTermList(block.removed)} / 追加: ${formatTermList(block.added)}`).join(' ; ');
  return diff || (formulaDiff ? '変更なし' : '変更差分の記録なし');
}

/** 保留・却下した実際の変更を、全式の履歴とは別に短く渡す。 */
export function formatRejectedChanges(trials: OptimizationTrial[], currentFormula: PubmedFormula): string {
  const rejected = trials.filter((trial) => trial.kind === 'proposal' && !trial.accepted);
  const normalize = (term: string) => term.trim().toLowerCase().replace(/\s+/g, ' ');
  const signature = (trial: OptimizationTrial, key: 'added' | 'removed') => JSON.stringify(
    (trial.formulaDiff ?? []).filter((block) => block[key].length)
      .map((block) => [block.blockId, [...new Set(block[key].map(normalize))].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const lines = rejected.map((trial, index) => {
    const diff = formatFormulaDiff(trial.formulaDiff);
    const changedIds = trial.formulaDiff ? trial.formulaDiff.map((block) => block.blockId)
      : trial.changes?.targetBlockId ? [trial.changes.targetBlockId] : [];
    const changedBlocks = changedIds.flatMap((id) => {
      const block = trial.formula.blocks.find((candidate) => candidate.id === id && !candidate.isCombination);
      return block ? [block] : [];
    });
    const sameOtherBlocks = trial.formula.blocks.length === currentFormula.blocks.length
      && trial.formula.blocks.every((block, i) => {
        const current = currentFormula.blocks[i]!;
        return block.id === current.id && block.isCombination === current.isCombination
          && (changedBlocks.some((changed) => changed.id === block.id) || block.expression === current.expression);
      })
      && trial.formula.combinationExpression === currentFormula.combinationExpression;
    const formulaDetails = changedBlocks.length
      ? ` / 変更後の式: ${changedBlocks.map((block) => `#${block.id} = ${block.expression}`).join(' ; ')}`
        + ` / 現在の式との関係: ${sameOtherBlocks ? 'このブロック以外は現在の式と同じ（同じブロックにこの式を出すと同一式）' : '他のブロックが現在の式と異なる'}`
      : '';
    if (trial.duplicateOf) {
      const listedOriginal = rejected.some((other, otherIndex) => otherIndex !== index && other.candidateId === trial.duplicateOf);
      return `${trial.candidateId} / ${diff}（${trial.duplicateOf} と同じ式） / 結果: 測定せずに却下${listedOriginal ? '' : formulaDetails}`;
    }
    const variant = signature(trial, 'removed') === '[]' ? undefined : rejected.slice(0, index).find((previous) =>
      signature(previous, 'removed') === signature(trial, 'removed')
      && signature(previous, 'added') !== signature(trial, 'added'));
    const result = trial.held ? `保留（失う ${trial.impact?.lostHits ?? '未測定'} 件・増える ${trial.impact?.gainedHits ?? '未測定'} 件）`
      : `却下（${trial.reason}）`;
    return `${trial.candidateId} / ${diff}${variant ? `（${variant.candidateId} と同じ削除の変種）` : ''} / 結果: ${result}${formulaDetails}`;
  });
  const duplicates = rejected.filter((trial) => trial.duplicateOf);
  if (duplicates.length) {
    const references = duplicates.map((trial) => `${trial.candidateId} → ${trial.duplicateOf}`).join(', ');
    lines.unshift(`注意: 評価済みの式と同じ式を再提案し、測定せずに却下した回が ${duplicates.length} 回あります（${references}）。同一式の再提案は改善なし（採用にも保留にもならない回）に数えられ、2 回続くと run は停止します。各行の「変更後の式」と同じ式を出さないでください。`);
  }
  return lines.join('\n') || '(なし)';
}

const TRIAL_KIND_LABELS: Record<OptimizationTrial['kind'], string> = {
  initial: '初期実測', proposal: '変更案', information: '情報要求', finish: '終了判断', final: '最終再検証',
};

/** 履歴画面（queryOptimizationHistory.ts）の表記と揃える。同じ語で読めるようにするため。 */
function trialOutcomeLabel(trial: OptimizationTrial): string {
  return trial.kind === 'information' ? '評価保留'
    : trial.kind === 'finish' ? (trial.finishRejectedReason ? '終了判断（受け付けず）' : '終了判断')
    : trial.held ? '保留' : trial.accepted ? '採用' : '却下';
}

function truncateRationale(rationale: string): string {
  return rationale.length > TRIAL_SUMMARY_RATIONALE_LIMIT
    ? `${rationale.slice(0, TRIAL_SUMMARY_RATIONALE_LIMIT)}…` : rationale;
}

/** 欠測（未計測）と実測 0 件を区別する。measurement が無い（測定していない）ときは呼び出し元が理由を渡す。 */
function measurementCounts(measurement: OptimizationMeasurement | null | undefined): { hits: string; seedCapture: string } {
  if (!measurement) return { hits: '未測定', seedCapture: '未測定' };
  const hits = measurement.totalHits == null ? '未測定' : String(measurement.totalHits);
  const seedCapture = measurement.capturedPmids == null || measurement.missedPmids == null ? '未測定'
    : `${measurement.capturedPmids.length}/${measurement.capturedPmids.length + measurement.missedPmids.length}`;
  return { hits, seedCapture };
}

/**
 * 試行履歴を要約する。全式・terms を含む測定 JSON は渡さず、4 つの数（件数・シード捕捉・
 * 失う集合・増える集合）と却下・保留理由、測定 ID だけを渡す。詳細は trial_detail_ids で取り出す。
 */
function summarizeTrials(trials: OptimizationTrial[]): string {
  if (!trials.length) return '(なし)';
  let prevAfterId: string | null = null;
  const lines = trials.map((trial) => {
    // 直前の試行の変更後と同じ測定なら、件数は繰り返さず ID だけ残す（重複回避が本来の目的）。
    const beforeIsPriorAfter = trial.before !== null && trial.before !== undefined && trial.before.id === prevAfterId;
    const before = beforeIsPriorAfter ? { hits: '(直前の試行の変更後と同一)', seedCapture: '(直前の試行の変更後と同一)' }
      : measurementCounts(trial.before);
    const afterUnmeasuredLabel = trial.after === null
      ? (trial.kind === 'proposal' ? '未測定（測定前に却下）' : '(対象外: この試行では式を変更していません)')
      : undefined;
    const after = afterUnmeasuredLabel ? { hits: afterUnmeasuredLabel, seedCapture: afterUnmeasuredLabel } : measurementCounts(trial.after);
    prevAfterId = trial.after?.id ?? prevAfterId;
    const summary = {
      candidateId: trial.candidateId,
      kind: TRIAL_KIND_LABELS[trial.kind],
      outcome: trialOutcomeLabel(trial),
      ...(trial.kind === 'proposal' ? { diff: formatFormulaDiff(trial.formulaDiff) } : {}),
      beforeMeasurementId: trial.before?.id ?? '(未測定)',
      beforeHits: before.hits, beforeSeedCapture: before.seedCapture,
      afterMeasurementId: trial.after?.id ?? afterUnmeasuredLabel ?? '(未測定)',
      afterHits: after.hits, afterSeedCapture: after.seedCapture,
      lostHits: trial.impact ? (trial.impact.lostHits ?? '未測定') : '(差集合は測っていない)',
      gainedHits: trial.impact ? (trial.impact.gainedHits ?? '未測定') : '(差集合は測っていない)',
      reason: trial.reason || '(なし)',
      ...(trial.impact?.error ? { error: trial.impact.error } : {}),
      ...(trial.duplicateOf ? { duplicateOf: trial.duplicateOf } : {}),
      ...(trial.informedBy ? { informedBy: `${trial.informedBy.candidateId}（反映 ${trial.informedBy.obtained}/要求 ${trial.informedBy.requested}）` } : {}),
      ...(trial.finishKind ? { finishKind: trial.finishKind } : {}),
      ...(trial.kind === 'information' ? { meshRequests: (trial.meshRequests ?? [])
        .map((request) => `${request.descriptor || '(未指定)'} / ${request.treeNumber || '(未指定)'}`) } : {}),
      ...(trial.trialDetailIds?.length ? { trialDetailIds: trial.trialDetailIds } : {}),
      ...(trial.informationResult ? { informationResult: `反映 ${trial.informationResult.obtained}/要求 ${trial.informationResult.requested}` } : {}),
      rationale: truncateRationale(trial.rationale || ''),
    };
    return JSON.stringify(summary);
  });
  return lines.join('\n');
}

/** 前回の情報要求で取り出した試行詳細を、次の 1 回の判断にだけ渡す形式にする。 */
function formatTrialDetails(details: OptimizeQueryTrialDetailResult[] | undefined): string {
  if (!details?.length) return '(要求なし)';
  return details.map((detail) => {
    if (!detail.formula) return `${detail.candidateId}: 取り出せませんでした（${detail.note ?? '理由不明'}）`;
    return [
      `${detail.candidateId}:`,
      formatContext({ formula: detail.formula, reason: detail.reason, rationale: detail.rationale }),
      `変更前: ${detail.before ? formatMeasurement(detail.before) : '(未計測)'}`,
      `変更後: ${detail.after ? formatMeasurement(detail.after) : '(未計測)'}`,
      `削除影響: ${detail.impact ? formatContext(detail.impact) : '(未実測)'}`,
    ].join('\n');
  }).join('\n\n');
}
