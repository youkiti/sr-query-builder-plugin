import type { LLMProvider } from '@/lib/llm';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { renderPromptTemplate } from './renderPromptTemplate';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

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
  /** 変更前 NOT 変更後 の実測件数。失敗時は null（未測定を 0 件として扱わない）。 */
  lostHits: number | null;
  /** 変更後 NOT 変更前 の実測件数。失敗時は null。 */
  gainedHits: number | null;
  /** 失う集合のうち書誌を取得した先頭の数件。集合全体を安全と判断する根拠にはしない。 */
  inspected: { pmid: string; title: string | null; year: number | null }[];
  /** 実測・書誌取得の失敗理由。成功時は null。 */
  error: string | null;
}

export interface OptimizationTrial {
  /** 採用判定を通ったが削除影響の確認が必要なため、レビュー候補として保留した試行。 */
  held?: boolean;
  /** 採用判定の直前に実測した差集合。判定前に却下した試行には無い。 */
  impact?: OptimizationImpact;
  kind: 'initial' | 'proposal' | 'information' | 'final';
  /** 変更案の生成時は必須。MeSH の変更語も run の文脈への参照として使う。 */
  changes?: Pick<OptimizeQueryProposal, 'targetBlockId' | 'addedTerms' | 'removedTerms' | 'replacedTerms'>;
  /** 情報要求の対象だけを保持し、ノード本体は run の文脈から引く。 */
  meshRequests?: OptimizationMeshRequest[];
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
}

export interface OptimizeQueryInput {
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
  meshRequests: OptimizationMeshRequest[];
}

const SKILL_NAME = 'optimize-query';

export const OPTIMIZE_QUERY_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。研究基準と全式の結合構造を踏まえて、
1 回に承認済み概念ブロック 1 件の変更案を JSON だけで返してください。
- 初期式が目標内でも冗長語・低寄与語・シード漏れを分析し、修正要否を判断してください。
  修正不要なら現在と同じ対象 ID・式を返し、理由を説明してください。
- ID の追加・削除・変更、結合行と研究デザインフィルタの変更は禁止です。
- proposed_expression はタグ付き検索語と AND/OR/NOT・括弧で構成する単一行です。
  他ブロック参照、PMID 指定、研究基準にない期間・言語・対象集団の制限を追加しません。
- 捕捉済みシードを維持し、漏れがあれば回収を優先します。全件捕捉後は最大件数を目指し、
  目標内でさらに件数を小さくすること自体を目的にしません。
- 未計測・失敗は不明であり 0 件ではありません。単独件数と累積 OR の純増 Δ は
  最終式での固有寄与とは異なります。少数でも必要な概念やシードを拾う語は保持します。
- 冗長・低寄与を削除の確証とせず、変更案全体を制御側が再実測します。
- 未捕捉シードがある間は削除案を出しません。捕捉表で落としているブロックと未捕捉書誌の
  語・MeSH を照らし、そのブロックへの同義語追加・MeSH 拡張を優先します。
  抄録の無い文献は索引語（MeSH・タイトル語）から考えます。承認外のブロック
  （研究デザインフィルタ）や結合構造が落としている場合は、語の変更では回収できないことを
  rationale に書き、変更不要なら現在の式を返します。
- 変更前に当たって変更後に当たらない文献（失う集合）が 1 件でもある変更案は自動採用されず保留になります。
  削除・置換を提案するときは、失う集合が 0 件になる冗長整理か、
  失う理由を rationale で説明できる変更に限ってください。
- MeSH は提供された実在ノードと親子関係を根拠にし、未取得の関係を推測しません。
  NoExp・qualifier・MajorTopic の変更は別の操作として理由を示します。
- 周辺の外を調べる必要があれば mesh_requests に descriptor / tree_number を指定します。
  少なくとも片方を指定し、不要なら空配列を返します。要求は優先順に並べてください。
  要求がある回は式を変更せず、追加取得の結果を次の反復で読んでから提案してください。
  取得は 1 反復 3 件までです。未取得・失敗・打ち切りの説明を読み、関係を推測しません。
- 却下理由と前後の実測を読み、同じ失敗を繰り返しません。
- rationale は日本語で研究基準との意味的整合性の検討結果を含めます。
  これは AI の判断であって機械的な保証ではありません。
- 件数の予想は出力しません。measurement_ids には実際に参照した測定 ID だけを返します。
`.trim();

export const OPTIMIZE_QUERY_USER_PROMPT_TEMPLATE = `
研究基準:
{{CRITERIA}}
最大件数（最終式の目標上限）: {{MAX_HITS}}
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
周辺 MeSH ツリー（親子・全 tree number・explode/NoExp）:
{{MESH}}
MeSH 追加取得要求の結果（未取得理由を含む）:
{{MESH_REQUEST_RESULTS}}
試行履歴（採否・却下理由・前後の実測）:
{{TRIALS}}
過去の run の却下記録（未再検証。今回の実測ではなく、同じ失敗を避けるための文脈）:
{{PREVIOUS_REJECTIONS}}
スキーマ:
{
  "target_block_id": "<変更対象 ID>",
  "proposed_expression": "<変更後の式。変更不要なら現在の式>",
  "added_terms": ["<追加語>"],
  "removed_terms": ["<削除語>"],
  "replaced_terms": [{"before": "<置換前>", "after": "<置換後>"}],
  "rationale": "<日本語の変更理由・修正要否>",
  "measurement_ids": ["<参照した測定 ID>"],
  "mesh_requests": [{"descriptor": "<展開対象の descriptor>", "tree_number": "<展開対象の枝。未指定なら空文字>"}]
}
`.trim();

interface RawOptimizationProposal {
  target_block_id?: string;
  proposed_expression?: string;
  added_terms?: string[];
  removed_terms?: string[];
  replaced_terms?: { before?: string; after?: string }[];
  rationale?: string;
  measurement_ids?: string[];
  mesh_requests?: { descriptor?: string; tree_number?: string }[];
}

const OPTIMIZE_QUERY_SCHEMA = objectSchema({
  target_block_id: stringSchema('承認済み概念ブロックの ID'),
  proposed_expression: stringSchema('変更後の単一行の式'),
  added_terms: arraySchema(stringSchema()),
  removed_terms: arraySchema(stringSchema()),
  replaced_terms: arraySchema(objectSchema({ before: stringSchema(), after: stringSchema() })),
  rationale: stringSchema('日本語の変更理由・修正要否'),
  measurement_ids: arraySchema(stringSchema()),
  mesh_requests: arraySchema(objectSchema({
    descriptor: stringSchema('展開対象の descriptor。tree number だけで指定するときは空文字'),
    tree_number: stringSchema('展開対象の tree number。descriptor だけで指定するときは空文字'),
  })),
});

export async function optimizeQuery(
  input: OptimizeQueryInput,
  provider: LLMProvider
): Promise<OptimizeQueryProposal> {
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
    MESH: formatContext(input.meshContext),
    MESH_REQUEST_RESULTS: formatContext(input.meshRequestResults),
    PREVIOUS_REJECTIONS: formatContext(input.previousRejectedTrials ?? []),
    TRIALS: input.trials?.length ? input.trials.map((trial) => [
      formatContext({ candidateId: trial.candidateId, formula: trial.formula,
        accepted: trial.accepted, reason: trial.reason, rationale: trial.rationale,
        held: trial.held ?? false, impact: trial.impact ?? null }),
      `変更前: ${trial.before ? formatMeasurement(trial.before) : '(未計測)'}`,
      `変更後: ${trial.after ? formatMeasurement(trial.after) : '(未計測)'}`,
    ].join('\n')).join('\n') : '(なし)',
  });
  const response = await provider.chat([
    { role: 'system', content: OPTIMIZE_QUERY_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], { responseFormat: 'json', responseSchema: OPTIMIZE_QUERY_SCHEMA, temperature: 0.3 });
  const raw = parseSkillJson<RawOptimizationProposal>(response.text, SKILL_NAME);
  return {
    targetBlockId: (raw.target_block_id ?? '').trim(),
    proposedExpression: (raw.proposed_expression ?? '').trim(),
    addedTerms: raw.added_terms ?? [],
    removedTerms: raw.removed_terms ?? [],
    replacedTerms: (raw.replaced_terms ?? []).map((term) => ({ before: term.before ?? '', after: term.after ?? '' })),
    rationale: raw.rationale ?? '',
    measurementIds: raw.measurement_ids ?? [],
    meshRequests: (raw.mesh_requests ?? []).map((request) => ({
      descriptor: (request.descriptor ?? '').trim(), treeNumber: (request.tree_number ?? '').trim(),
    })),
  };
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
