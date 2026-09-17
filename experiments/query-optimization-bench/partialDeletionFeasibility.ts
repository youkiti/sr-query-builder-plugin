/**
 * issue #205: 「保留削除案の部分実行」案の実現可能性を、保存済みの run.json だけを読んで測る
 * 解析スクリプト。実 API は一切叩かない。
 *
 * 案の中身（背景）: 自動調整で AI が評価済みと同じ式を再提案してきたとき、制御側が 1 回だけ
 * 差し戻して出し直しを求める（実装済み）。それでもまた同じ式を返した回に、制御側が代替候補を
 * 自分で組む、という案がある。組み方は「この run で保留（held）になった削除案のうち、1 つの
 * ブロックの OR 結合語を複数まとめて削除したものを見つけ、現在の最良式から、そのうち 1 語だけを
 * 削除した候補を作る」。
 *
 * このスクリプトが答えるのは「保存済みの run の中で、その候補が実際に何件作れたか」だけ。
 * 作れた候補が採用されたか・保留になったかは測らないし、測れない（実測していないため）。
 *
 * 手本: apiAudit.ts（純粋な読み取り関数を export + 表示用の render 関数 + 薄い main() +
 * if (require.main === module)）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expressionToOperatorSyntax } from '@/features/validation/precedenceMixing';
import { tokenizeOperands, normalizeOperand, type DiffToken } from '@/lib/search-formula-md/expression';
import { formulaFingerprint } from '@/app/services/queryEvaluationService';
import type { PubmedFormula, FormulaBlock } from '@/lib/search-formula-md';

// ---------------------------------------------------------------------------
// 入力データの型と読み取り
// ---------------------------------------------------------------------------

export interface Measurement {
  fingerprint: string;
  /**
   * `OptimizationMeasurement`（src/features/formula/skills/optimizeQuery.ts）と同じく、
   * NCBI 側の測定が失敗した試行では null になる（壊れたデータではなく正規のログの状態）。
   */
  totalHits: number | null;
  capturedPmids: string[] | null;
  missedPmids: string[] | null;
  /** 測定によっては無い（例: initial の after）。無い場合を 0 に補完してはいけない。 */
  terms?: { blockId: string; query: string; finalContribution?: number }[];
}

export interface TrialChanges {
  targetBlockId: string;
  /** 件数だけを使う。要素の形は addedTerms が文字列、replacedTerms が {before,after} 等ログにより異なる。 */
  addedTermsCount: number;
  replacedTermsCount: number;
}

/** 候補・差集合の実測結果。`lostHits`/`gainedHits` は測定に失敗すると null になる。 */
export interface TrialImpact {
  lostHits: number | null;
  gainedHits: number | null;
}

export interface Trial {
  kind: string;
  formula: PubmedFormula;
  before?: Measurement | null;
  after?: Measurement | null;
  accepted?: boolean;
  held?: boolean;
  duplicateOf?: string | null;
  resubmissionRequested?: boolean;
  changes?: TrialChanges | null;
  impact?: TrialImpact | null;
  finishKind?: string;
}

export interface RunFile {
  runId: string;
  label: string;
  gitCommit: string;
  model: string;
  maxHits: number;
  stopReason: string;
  trials: Trial[];
  sourcePath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`文字列配列ではありません: ${context}`);
  }
  return value as string[];
}

/** 測定失敗で null になりうるフィールド用。null はそのまま通し、それ以外は文字列配列として検証する。 */
function asStringArrayOrNull(value: unknown, context: string): string[] | null {
  if (value === null) return null;
  return asStringArray(value, context);
}

/** 測定失敗で null になりうるフィールド用。null はそのまま通し、それ以外は数値として検証する。 */
function asNumberOrNull(value: unknown, context: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') throw new Error(`数値でも null でもありません: ${context}`);
  return value;
}

/**
 * `changes.addedTerms` / `removedTerms` / `replacedTerms` の件数だけを見る（要素の形は使わない）。
 * `replacedTerms` は `{ before, after }` オブジェクトの配列のことがあり、文字列配列とは限らない
 * （issue164-current ラベルの旧ログで実測）。要素の中身は判定に使わないので、配列であることだけ確かめる。
 */
function asUnknownArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`配列ではありません: ${context}`);
  return value;
}

function asMeasurement(value: unknown, context: string): Measurement | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error(`測定の形式が不正です: ${context}`);
  if (typeof value.fingerprint !== 'string') throw new Error(`fingerprint がありません: ${context}`);
  const totalHits = asNumberOrNull(value.totalHits, `${context}.totalHits`);
  const capturedPmids = asStringArrayOrNull(value.capturedPmids, `${context}.capturedPmids`);
  const missedPmids = asStringArrayOrNull(value.missedPmids, `${context}.missedPmids`);
  let terms: Measurement['terms'];
  if (value.terms !== undefined) {
    if (!Array.isArray(value.terms)) throw new Error(`terms の形式が不正です: ${context}`);
    terms = value.terms.map((term, index) => {
      if (!isObject(term) || typeof term.blockId !== 'string' || typeof term.query !== 'string') {
        throw new Error(`terms[${index}] の形式が不正です: ${context}`);
      }
      return {
        blockId: term.blockId,
        query: term.query,
        finalContribution: typeof term.finalContribution === 'number' ? term.finalContribution : undefined,
      };
    });
  }
  return { fingerprint: value.fingerprint, totalHits, capturedPmids, missedPmids, terms };
}

/** `impact`（候補・差集合の実測結果）。null/未指定なら null。 */
function asImpact(value: unknown, context: string): TrialImpact | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error(`impact の形式が不正です: ${context}`);
  return {
    lostHits: asNumberOrNull(value.lostHits, `${context}.lostHits`),
    gainedHits: asNumberOrNull(value.gainedHits, `${context}.gainedHits`),
  };
}

function asFormulaBlock(value: unknown, context: string): FormulaBlock {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.expression !== 'string'
    || typeof value.isCombination !== 'boolean') {
    throw new Error(`ブロックの形式が不正です: ${context}`);
  }
  return { id: value.id, expression: value.expression, isCombination: value.isCombination };
}

function asFormula(value: unknown, context: string): PubmedFormula {
  if (!isObject(value) || !Array.isArray(value.blocks)) throw new Error(`formula の形式が不正です: ${context}`);
  const blocks = value.blocks.map((block, index) => asFormulaBlock(block, `${context}.blocks[${index}]`));
  const combinationExpression = value.combinationExpression;
  if (combinationExpression !== null && typeof combinationExpression !== 'string') {
    throw new Error(`combinationExpression の形式が不正です: ${context}`);
  }
  return { blocks, combinationExpression };
}

function asChanges(value: unknown, context: string): TrialChanges | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || typeof value.targetBlockId !== 'string') {
    throw new Error(`changes の形式が不正です: ${context}`);
  }
  return {
    targetBlockId: value.targetBlockId,
    addedTermsCount: asUnknownArray(value.addedTerms, `${context}.addedTerms`).length,
    replacedTermsCount: asUnknownArray(value.replacedTerms, `${context}.replacedTerms`).length,
  };
}

function asTrial(value: unknown, context: string): Trial {
  if (!isObject(value) || typeof value.kind !== 'string') throw new Error(`trial の形式が不正です: ${context}`);
  return {
    kind: value.kind,
    formula: asFormula(value.formula, `${context}.formula`),
    before: asMeasurement(value.before, `${context}.before`),
    after: asMeasurement(value.after, `${context}.after`),
    accepted: typeof value.accepted === 'boolean' ? value.accepted : undefined,
    held: typeof value.held === 'boolean' ? value.held : undefined,
    duplicateOf: typeof value.duplicateOf === 'string' ? value.duplicateOf : null,
    resubmissionRequested: typeof value.resubmissionRequested === 'boolean' ? value.resubmissionRequested : undefined,
    changes: asChanges(value.changes, `${context}.changes`),
    impact: asImpact(value.impact, `${context}.impact`),
    finishKind: typeof value.finishKind === 'string' ? value.finishKind : undefined,
  };
}

/** 対象ディレクトリ以下を再帰的に走査し、`run.json`（引数自体がファイルならそれ）を集める。 */
function findRunFiles(path: string): string[] {
  if (!existsSync(path)) throw new Error(`入力が存在しません: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? findRunFiles(child) : entry.isFile() && entry.name === 'run.json' ? [child] : [];
  });
}

/**
 * `results/` に保存する run.json の `label` は `eval:optimize` の `--label` に対応し、
 * 省略可能（`experiments/query-optimization-bench/types.ts` の `RunResult.label` も
 * `label?: string`）。ラベル無しの通常実行結果を「対象外」として読み飛ばすと、正規のログが
 * 黙って集計から落ちる。ラベルが無い run.json にはこの既定名を補い、`--label` で明示的に
 * 指定して絞り込むこともできるようにする。
 */
export const DEFAULT_LABEL = '(ラベル未指定)';

/**
 * `results/` には自動調整以外のツール（marginDesign.ts 等）も同名 `run.json` を残しており、
 * トップレベルの形が別物（`runId`/`optimization.trials` を持たない）。それらは
 * 「この解析の対象ではない」として静かに読み飛ばす（null）。自動調整のログかどうかは
 * `runId` と `optimization.trials` の有無だけで判定し、`label` の有無では判定しない
 * （label は省略可能なため）。runId・trials 配列が揃っているのに中身が壊れている場合は、
 * 自動調整の run.json とみなして厳格に検証し、例外にする。
 */
export function parseRunFile(path: string): RunFile | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`run.json が壊れています: ${path}`); }
  if (!isObject(raw)) return null;
  const { runId, label, gitCommit, model, maxHits, optimization } = raw;
  if (typeof runId !== 'string' || !runId || !isObject(optimization) || !Array.isArray(optimization.trials)) {
    return null;
  }
  if (typeof gitCommit !== 'string') throw new Error(`gitCommit がありません: ${path}`);
  if (typeof model !== 'string') throw new Error(`model がありません: ${path}`);
  if (typeof maxHits !== 'number') throw new Error(`maxHits がありません: ${path}`);
  if (typeof optimization.stopReason !== 'string') throw new Error(`stopReason がありません: ${path}`);
  const trials = optimization.trials.map((trial, index) => asTrial(trial, `${path}#trials[${index}]`));
  const resolvedLabel = typeof label === 'string' ? label : DEFAULT_LABEL;
  return { runId, label: resolvedLabel, gitCommit, model, maxHits, stopReason: optimization.stopReason, trials, sourcePath: path };
}

/** runId で重複排除する（同じ run が 2 箇所に保存されているため）。先に見つかったものを残す。 */
function dedupeRuns(runs: RunFile[]): RunFile[] {
  const seen = new Map<string, RunFile>();
  for (const run of runs) if (!seen.has(run.runId)) seen.set(run.runId, run);
  return [...seen.values()];
}

function groupByLabel(runs: RunFile[]): Map<string, RunFile[]> {
  const groups = new Map<string, RunFile[]>();
  for (const run of runs) {
    const list = groups.get(run.label) ?? [];
    list.push(run);
    groups.set(run.label, list);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 第 1 節: 再現ゲート
// ---------------------------------------------------------------------------

export interface FollowUpBreakdown {
  noNext: number;
  finish: Record<string, number>;
  sameFormula: number;
  /**
   * 情報要求（`kind: 'information'`。src/app/services/queryOptimizationService.ts が
   * request_context への応答として push する正規の試行種別）。run あたり 3 回の別予算で、
   * 変更案そのものではないため「新案」には数えない。
   */
  information: number;
  proposal: { accepted: number; held: number; rejected: number };
  /** finish / same-formula / proposal / information のどれでもない、本当に未知の kind。 */
  unknown: Record<string, number>;
}

type FollowUpTag =
  | { kind: 'no-next' }
  | { kind: 'finish'; finishKind: string }
  | { kind: 'same-formula' }
  | { kind: 'information' }
  | { kind: 'proposal'; outcome: 'accepted' | 'held' | 'rejected' }
  | { kind: 'unknown'; actualKind: string };

/**
 * 差し戻し（trials[i].resubmissionRequested === true）の直後の試行を分類する。
 * 判定順は brief のとおり: 次の試行が無い → finish → duplicateOf あり → proposal。
 * `information`（情報要求）は変更案でも同じ式でもない独立の正規区分として扱い、
 * それ以外の本当に未知の kind は `proposal/rejected` に吸収せず unknown として数える。
 */
export function classifyFollowUp(trials: Trial[], i: number): FollowUpTag {
  const next = trials[i + 1];
  if (!next) return { kind: 'no-next' };
  if (next.kind === 'finish') return { kind: 'finish', finishKind: next.finishKind ?? '不明' };
  if (next.duplicateOf) return { kind: 'same-formula' };
  if (next.kind === 'proposal') {
    if (next.accepted === true) return { kind: 'proposal', outcome: 'accepted' };
    if (next.held === true) return { kind: 'proposal', outcome: 'held' };
    return { kind: 'proposal', outcome: 'rejected' };
  }
  if (next.kind === 'information') return { kind: 'information' };
  return { kind: 'unknown', actualKind: next.kind };
}

export interface Section1 {
  label: string;
  fileCount: number;
  runCount: number;
  gitCommits: string[];
  models: string[];
  stopReasonCounts: Record<string, number>;
  heldTrialCount: number;
  duplicateTrialCount: number;
  resubmissionCount: number;
  followUp: FollowUpBreakdown;
}

function buildSection1(label: string, fileCount: number, runs: RunFile[]): Section1 {
  const stopReasonCounts: Record<string, number> = {};
  let heldTrialCount = 0;
  let duplicateTrialCount = 0;
  let resubmissionCount = 0;
  const followUp: FollowUpBreakdown = {
    noNext: 0, finish: {}, sameFormula: 0, information: 0, proposal: { accepted: 0, held: 0, rejected: 0 }, unknown: {},
  };
  for (const run of runs) {
    stopReasonCounts[run.stopReason] = (stopReasonCounts[run.stopReason] ?? 0) + 1;
    run.trials.forEach((trial, index) => {
      if (trial.held === true) heldTrialCount++;
      if (trial.duplicateOf) duplicateTrialCount++;
      if (trial.resubmissionRequested === true) {
        resubmissionCount++;
        const tag = classifyFollowUp(run.trials, index);
        if (tag.kind === 'no-next') followUp.noNext++;
        else if (tag.kind === 'finish') followUp.finish[tag.finishKind] = (followUp.finish[tag.finishKind] ?? 0) + 1;
        else if (tag.kind === 'same-formula') followUp.sameFormula++;
        else if (tag.kind === 'information') followUp.information++;
        else if (tag.kind === 'proposal') followUp.proposal[tag.outcome]++;
        else followUp.unknown[tag.actualKind] = (followUp.unknown[tag.actualKind] ?? 0) + 1;
      }
    });
  }
  return {
    label, fileCount, runCount: runs.length,
    gitCommits: [...new Set(runs.map((run) => run.gitCommit))].sort(),
    models: [...new Set(runs.map((run) => run.model))].sort(),
    stopReasonCounts, heldTrialCount, duplicateTrialCount, resubmissionCount, followUp,
  };
}

// ---------------------------------------------------------------------------
// 第 2 節・第 3 節: 実現可能性 / 順位付けデータの有無
// ---------------------------------------------------------------------------

interface BestState { formula: PubmedFormula; measurement: Measurement }

/**
 * NCBI 測定が失敗すると `totalHits`/`capturedPmids`/`missedPmids` のいずれかが null になり、
 * 捕捉率・件数の判定ができない。測定オブジェクト自体が無い場合も同様に扱う。
 */
function isMeasurementInsufficient(measurement: Measurement | null | undefined): boolean {
  return !measurement || measurement.totalHits === null || measurement.capturedPmids === null
    || measurement.missedPmids === null;
}

/** trials[0..uptoExclusive) を先頭から辿り、その時点の最良式を求める。 */
function foldBest(trials: Trial[], uptoExclusive: number): BestState | null {
  let best: BestState | null = null;
  for (let i = 0; i < uptoExclusive; i++) {
    const trial = trials[i]!;
    const isInitial = trial.kind === 'initial';
    const isAcceptedProposal = trial.kind === 'proposal' && trial.accepted === true;
    if ((isInitial || isAcceptedProposal) && trial.after) {
      best = { formula: trial.formula, measurement: trial.after };
    }
  }
  return best;
}

/**
 * 語別測定（terms）は初期測定のあとに同じ測定へ追記されるため、`initial.after` 自身には
 * terms が無く、後続試行の `before`/`after`（同じ fingerprint）にだけ terms が乗っていることが
 * ある（実測: run `...693f7bbe` の `trials[0].after` に terms 無し、`trials[1..6].before`
 * （同一 fingerprint）に terms 35 件）。fingerprint が同じなら同じ式の測定なので、run 全体
 * （before・after 両方）から terms を持つものを探して補う。
 * どこにも terms が無ければ undefined のまま（0 に補完しない）。
 */
function resolveTerms(trials: Trial[], fingerprint: string): Measurement['terms'] {
  for (const trial of trials) {
    if (trial.before && trial.before.fingerprint === fingerprint && trial.before.terms) return trial.before.terms;
    if (trial.after && trial.after.fingerprint === fingerprint && trial.after.terms) return trial.after.terms;
  }
  return undefined;
}

/** best の測定に terms が無ければ、run 全体から同じ fingerprint の terms を探して補う。 */
function enrichBestWithTerms(trials: Trial[], best: BestState): BestState {
  if (best.measurement.terms) return best;
  const terms = resolveTerms(trials, best.measurement.fingerprint);
  if (!terms) return best;
  return { formula: best.formula, measurement: { ...best.measurement, terms } };
}

function findBlock(formula: PubmedFormula, blockId: string): FormulaBlock | undefined {
  return formula.blocks.find((block) => block.id === blockId);
}

/**
 * ブロックの式が OR だけで結ばれているか（AND/NOT を含まないか）。
 * PubMed の演算子は大文字だけが有効（`and`/`or` は演算子として解釈されない）なので、
 * 小文字を演算子とみなして過剰に「OR-only でない」と判定しないよう大文字小文字を区別する。
 */
function isOrOnlyExpression(expression: string): boolean {
  const { syntax } = expressionToOperatorSyntax(expression);
  return !/\b(AND|NOT)\b/.test(syntax);
}

/** 結合式が単純な AND か（OR/NOT を含まないか）。combinationExpression が無ければ判定不能として false。 */
function isSimpleAndCombination(combinationExpression: string | null): boolean {
  if (combinationExpression === null) return false;
  return !/\b(OR|NOT)\b/.test(combinationExpression);
}

function isOperatorGlue(text: string): boolean {
  return /^\s*(OR|AND|NOT)\s*$/i.test(text);
}

/**
 * OR だけで結ばれた式から、指定した 1 語（正規化済みテキストで照合）だけを削除する。
 * 削除対象に隣接する OR も 1 つ取り除き、`(A OR OR B)` のような壊れた式を残さない。
 * 対象語が見つからなければ null。
 */
function removeOperand(expression: string, targetNormalized: string): string | null {
  const tokens = tokenizeOperands(expression);
  const targetIndex = tokens.findIndex((token) => token.isOperand && normalizeOperand(token.text) === targetNormalized);
  if (targetIndex === -1) return null;
  const removeIndices = new Set<number>([targetIndex]);
  const next = tokens[targetIndex + 1];
  const previous = tokens[targetIndex - 1];
  if (next && !next.isOperand && isOperatorGlue(next.text)) removeIndices.add(targetIndex + 1);
  else if (previous && !previous.isOperand && isOperatorGlue(previous.text)) removeIndices.add(targetIndex - 1);
  return tokens.filter((_, index) => !removeIndices.has(index)).map((token) => token.text).join('');
}

function withBlockExpression(formula: PubmedFormula, blockId: string, expression: string): PubmedFormula {
  return {
    blocks: formula.blocks.map((block) => (block.id === blockId ? { ...block, expression } : block)),
    combinationExpression: formula.combinationExpression,
  };
}

function operandTokens(expression: string): DiffToken[] {
  return tokenizeOperands(expression).filter((token) => token.isOperand);
}

interface QualifyingHeld { trialIndex: number; targetBlockId: string; removedOperands: string[] }

/**
 * 条件 d が満たされない理由。「ただ 0 と出すだけのレポートにはしない」ため、
 * held===true の試行ごとに、どの下位条件で対象外になったかを記録する。
 * - no-held: held===true の試行が eventIndex より前に 1 件も無い
 * - missing-measurement: before/after の測定が無い、または capturedPmids が null（測定失敗）
 * - fingerprint-mismatch: before.fingerprint が現在の best と一致しない
 * - captured-lost: 捕捉済みシードを失っている
 * - changes-mixed: changes が無い／addedTerms・replacedTerms が空でない／対象ブロックが見つからない
 * - not-or-only: 変更前・変更後どちらかのブロック式が OR だけで結ばれていない
 * - single-removal: 削除された被演算子が 1 語以下
 */
export type DFailureReason =
  | 'no-held' | 'missing-measurement' | 'fingerprint-mismatch' | 'captured-lost'
  | 'changes-mixed' | 'not-or-only' | 'single-removal';

interface HeldEvaluation {
  qualifying: QualifyingHeld[];
  /** held===true だった試行それぞれについて、対象外になった理由（qualify したものは含まない）。 */
  reasons: DFailureReason[];
}

/**
 * 条件 d: eventIndex より前の試行から、次をすべて満たす保留（held）を探す。
 * - before.fingerprint が現在の best と一致する
 * - 捕捉済みシードを失っていない
 * - changes.targetBlockId が 1 つで、addedTerms・replacedTerms が空
 * - そのブロックの変更前・変更後の式がどちらも OR だけで結ばれている
 * - 変更後 = 変更前から 2 語以上の被演算子を完全に削除したもの
 */
function findQualifyingHeldTrials(trials: Trial[], eventIndex: number, best: BestState): HeldEvaluation {
  const qualifying: QualifyingHeld[] = [];
  const reasons: DFailureReason[] = [];
  for (let index = 0; index < eventIndex; index++) {
    const trial = trials[index]!;
    if (trial.held !== true) continue;
    if (!trial.before || !trial.after) { reasons.push('missing-measurement'); continue; }
    if (trial.before.fingerprint !== best.measurement.fingerprint) { reasons.push('fingerprint-mismatch'); continue; }
    const { capturedPmids: beforeCaptured } = trial.before;
    const { capturedPmids: afterCaptured } = trial.after;
    if (beforeCaptured === null || afterCaptured === null) { reasons.push('missing-measurement'); continue; }
    if (!beforeCaptured.every((pmid) => afterCaptured.includes(pmid))) { reasons.push('captured-lost'); continue; }
    const changes = trial.changes;
    if (!changes || changes.addedTermsCount > 0 || changes.replacedTermsCount > 0) {
      reasons.push('changes-mixed'); continue;
    }
    const beforeBlock = findBlock(best.formula, changes.targetBlockId);
    const afterBlock = findBlock(trial.formula, changes.targetBlockId);
    if (!beforeBlock || !afterBlock) { reasons.push('changes-mixed'); continue; }
    if (!isOrOnlyExpression(beforeBlock.expression) || !isOrOnlyExpression(afterBlock.expression)) {
      reasons.push('not-or-only'); continue;
    }
    const beforeOperands = operandTokens(beforeBlock.expression);
    const afterOperandKeys = new Set(operandTokens(afterBlock.expression).map((token) => normalizeOperand(token.text)));
    const beforeOperandKeys = new Set(beforeOperands.map((token) => normalizeOperand(token.text)));
    const noAdditions = [...afterOperandKeys].every((key) => beforeOperandKeys.has(key));
    if (!noAdditions) { reasons.push('changes-mixed'); continue; }
    const removedOperands = beforeOperands
      .filter((token) => !afterOperandKeys.has(normalizeOperand(token.text)))
      .map((token) => token.text);
    if (removedOperands.length < 2) { reasons.push('single-removal'); continue; }
    qualifying.push({ trialIndex: index, targetBlockId: changes.targetBlockId, removedOperands });
  }
  if (qualifying.length === 0 && reasons.length === 0) reasons.push('no-held');
  return { qualifying, reasons };
}

export interface CreatedCandidate { blockId: string; removedTerm: string; fingerprint: string }

/** 条件 e: qualifying が削除した各語について、best から 1 語だけ削除した候補を作り、未評価のものだけ残す。 */
async function buildCandidates(
  best: BestState, qualifying: QualifyingHeld[], evaluatedFingerprints: Set<string>,
): Promise<CreatedCandidate[]> {
  const seen = new Set<string>();
  const results: CreatedCandidate[] = [];
  for (const held of qualifying) {
    const block = findBlock(best.formula, held.targetBlockId);
    if (!block) continue;
    for (const term of held.removedOperands) {
      const newExpression = removeOperand(block.expression, normalizeOperand(term));
      if (newExpression === null) continue;
      const candidateFormula = withBlockExpression(best.formula, held.targetBlockId, newExpression);
      const fingerprint = await formulaFingerprint(candidateFormula);
      if (evaluatedFingerprints.has(fingerprint) || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      results.push({ blockId: held.targetBlockId, removedTerm: term, fingerprint });
    }
  }
  return results;
}

/**
 * 本体（`runQueryOptimization`, src/app/services/queryOptimizationService.ts）が重複判定に使う
 * `seen` Map への登録条件を再現する。`initial` は無条件で登録するが、`proposal` は
 * 「候補自身の測定が失敗していない」かつ「差集合の実測（impact.lostHits/gainedHits）が
 * 失敗していない」場合だけ登録し、再測定の機会を残すために測定失敗の式は登録しない。
 */
function wasRegisteredAsEvaluated(trial: Trial): boolean {
  if (trial.kind === 'initial') return true;
  if (trial.kind !== 'proposal') return false;
  const failed = isMeasurementInsufficient(trial.after);
  const impactFailed = trial.impact != null && (trial.impact.lostHits === null || trial.impact.gainedHits === null);
  return !failed && !impactFailed;
}

/**
 * この時点（trialIndex より前）までに既に評価済みの式の指紋集合。run 全体（未来の試行を含む）
 * から集めてしまうと、イベントの時点ではまだ評価されていない後続候補まで「評価済み」に含まれ、
 * まだ試していないはずの候補を誤って除外してしまう。
 */
async function collectEvaluatedFingerprints(trials: Trial[], uptoExclusive: number): Promise<Set<string>> {
  const evaluated = trials.slice(0, uptoExclusive).filter(wasRegisteredAsEvaluated);
  const fingerprints = await Promise.all(evaluated.map((trial) => formulaFingerprint(trial.formula)));
  return new Set(fingerprints);
}

/**
 * `measurement-insufficient` は条件 a の手前に置く前提条件。best の測定
 * （totalHits/capturedPmids/missedPmids のいずれか）が NCBI 測定失敗で null のときに使う。
 * a〜e は brief 由来の判定条件そのもの。
 */
export type FailureCode = 'measurement-insufficient' | 'a' | 'b' | 'c' | 'd' | 'e';

export interface DuplicationEvent {
  runId: string;
  runLabel: string;
  trialIndex: number;
  bucket: 'resubmission' | 'no-resubmission';
  /**
   * この重複試行そのものが resubmissionRequested===true を立てているか。
   * bucket==='no-resubmission'（直前の試行が差し戻しではない）の内訳を、
   * 「この試行自体が差し戻しの引き金になった」か「差し戻しも経ずに完全にバイパスされた」かで
   * さらに分けるために使う。
   */
  selfResubmissionRequested: boolean;
  best: BestState;
  failedAt: FailureCode | null;
  /** failedAt==='d' のときの下位理由。 */
  dReasons: DFailureReason[];
  candidates: CreatedCandidate[];
}

async function evaluateDuplicationEvent(
  run: RunFile, trials: Trial[], dupIndex: number, bucket: DuplicationEvent['bucket'], selfResubmissionRequested: boolean,
): Promise<DuplicationEvent> {
  const rawBest = foldBest(trials, dupIndex);
  if (!rawBest) {
    throw new Error(`best を特定できません（initial 試行が見つかりません）: run=${run.runId} trial=${dupIndex}`);
  }
  const best = enrichBestWithTerms(trials, rawBest);
  const base = { runId: run.runId, runLabel: run.label, trialIndex: dupIndex, bucket, selfResubmissionRequested, best };
  // best の測定が NCBI 測定失敗で totalHits/capturedPmids/missedPmids のいずれか null なら、
  // 条件 a（既知シードを全件捕捉しているか）以降を判定できない。
  const { totalHits, missedPmids } = best.measurement;
  if (totalHits === null || best.measurement.capturedPmids === null || missedPmids === null) {
    return { ...base, failedAt: 'measurement-insufficient', dReasons: [], candidates: [] };
  }
  if (missedPmids.length !== 0) return { ...base, failedAt: 'a', dReasons: [], candidates: [] };
  if (!(totalHits > run.maxHits)) return { ...base, failedAt: 'b', dReasons: [], candidates: [] };
  if (!isSimpleAndCombination(best.formula.combinationExpression)) return { ...base, failedAt: 'c', dReasons: [], candidates: [] };
  const { qualifying, reasons } = findQualifyingHeldTrials(trials, dupIndex, best);
  if (qualifying.length === 0) return { ...base, failedAt: 'd', dReasons: reasons, candidates: [] };
  // 条件 e: このイベントより前（dupIndex より前）に評価済みだった式だけを「既に評価済み」とする。
  const evaluatedFingerprints = await collectEvaluatedFingerprints(trials, dupIndex);
  const candidates = await buildCandidates(best, qualifying, evaluatedFingerprints);
  if (candidates.length === 0) return { ...base, failedAt: 'e', dReasons: [], candidates: [] };
  return { ...base, failedAt: null, dReasons: [], candidates };
}

/**
 * 全 run の重複試行（duplicateOf あり）を、直前の試行が差し戻し（resubmissionRequested）だったか
 * どうかでバケット分けし、それぞれについて a〜e を評価する。
 */
export async function analyzeFeasibility(runs: RunFile[]): Promise<DuplicationEvent[]> {
  const events: DuplicationEvent[] = [];
  for (const run of runs) {
    for (let index = 0; index < run.trials.length; index++) {
      const trial = run.trials[index]!;
      if (!trial.duplicateOf) continue;
      const previous = index > 0 ? run.trials[index - 1] : undefined;
      const bucket: DuplicationEvent['bucket'] =
        previous?.resubmissionRequested === true ? 'resubmission' : 'no-resubmission';
      events.push(await evaluateDuplicationEvent(run, run.trials, index, bucket, trial.resubmissionRequested === true));
    }
  }
  return events;
}

export type ContributionBucket = '0件' | '1〜100件' | '101〜1,000件' | '1,000件超' | '不明';

export function classifyContribution(best: BestState, blockId: string, term: string): ContributionBucket {
  const terms = best.measurement.terms;
  if (!terms) return '不明';
  const match = terms.find((t) => t.blockId === blockId && normalizeOperand(t.query) === normalizeOperand(term));
  if (!match || typeof match.finalContribution !== 'number') return '不明';
  const value = match.finalContribution;
  if (value === 0) return '0件';
  if (value >= 1 && value <= 100) return '1〜100件';
  if (value >= 101 && value <= 1000) return '101〜1,000件';
  return '1,000件超';
}

// ---------------------------------------------------------------------------
// レポート組み立て・表示
// ---------------------------------------------------------------------------

export interface Report {
  section1: Section1[];
  events: DuplicationEvent[];
  /** 自動調整以外のツールが残した同名 run.json（marginDesign.ts 等）を読み飛ばした数。 */
  skippedFileCount: number;
}

export async function buildReport(dir: string, label?: string): Promise<Report> {
  const files = findRunFiles(dir);
  if (files.length === 0) throw new Error(`run.json がありません: ${dir}`);
  const allParsed = files.map(parseRunFile);
  const skippedFileCount = allParsed.filter((run) => run === null).length;
  let parsed = allParsed.filter((run): run is RunFile => run !== null);
  if (label !== undefined) parsed = parsed.filter((run) => run.label === label);
  if (parsed.length === 0) {
    throw new Error(label === undefined ? `run.json を読み取れませんでした: ${dir}` : `ラベルに一致する run.json がありません: ${label}`);
  }
  const groups = groupByLabel(parsed);
  const section1 = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupLabel, groupFiles]) => buildSection1(groupLabel, groupFiles.length, dedupeRuns(groupFiles)));
  const events = await analyzeFeasibility(dedupeRuns(parsed));
  return { section1, events, skippedFileCount };
}

function renderSection1(section: Section1): string[] {
  const lines: string[] = [];
  lines.push(`--- ラベル: ${section.label} ---`);
  lines.push(`run 数（重複排除後）: ${section.runCount}`);
  lines.push(`run.json ファイル数（重複排除前）: ${section.fileCount}`);
  lines.push(`コミット: ${section.gitCommits.join(', ')}`);
  lines.push(`モデル: ${section.models.join(', ')}`);
  lines.push('stopReason 内訳:');
  for (const [reason, count] of Object.entries(section.stopReasonCounts).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${reason}: ${count}`);
  }
  lines.push(`保留（held）の試行数: ${section.heldTrialCount}`);
  lines.push(`重複（duplicateOf）の試行数: ${section.duplicateTrialCount}`);
  lines.push(`差し戻し回数: ${section.resubmissionCount}`);
  lines.push(`  直後: 次の試行なし: ${section.followUp.noNext}`);
  lines.push(`  直後: 同じ式: ${section.followUp.sameFormula}`);
  const proposalTotal = section.followUp.proposal.accepted + section.followUp.proposal.held + section.followUp.proposal.rejected;
  lines.push(`  直後: 新案: ${proposalTotal}（採用 ${section.followUp.proposal.accepted}・保留 ${section.followUp.proposal.held}・却下 ${section.followUp.proposal.rejected}）`);
  lines.push(`  直後: 情報要求: ${section.followUp.information}`);
  for (const [finishKind, count] of Object.entries(section.followUp.finish).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  直後: finish（${finishKind}）: ${count}`);
  }
  for (const [kind, count] of Object.entries(section.followUp.unknown).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  直後: 未知の種別（${kind}）: ${count}`);
  }
  return lines;
}

const FAILURE_LABELS: Record<FailureCode, string> = {
  'measurement-insufficient': '測定不足（totalHits/capturedPmids/missedPmids のいずれかが null）',
  a: 'a（既知シードを全件捕捉していない）',
  b: 'b（totalHits が maxHits を超えていない）',
  c: 'c（結合式が単純な AND ではない）',
  d: 'd（条件を満たす保留候補が見つからない）',
  e: 'e（作った候補がすべて評価済みの式と一致した）',
};

const D_REASON_LABELS: Record<DFailureReason, string> = {
  'no-held': '該当する保留が 1 件も無い',
  'missing-measurement': 'before/after の測定が無い',
  'fingerprint-mismatch': 'fingerprint が best と一致しない',
  'captured-lost': '捕捉済みシードを失っている',
  'changes-mixed': '追加・置換が混じっている（またはブロックが見つからない）',
  'not-or-only': '変更前・変更後どちらかが OR-only でない',
  'single-removal': '削除が 1 語だけ',
};

/**
 * イベント一覧を表示する。第 2 節の各グループ（バケット）ごとに呼ぶ。
 * `d` で落ちた回は「ただ 0 と出すだけのレポートにはしない」ため、下位理由（DFailureReason）まで数える。
 */
function renderEventGroup(title: string, events: DuplicationEvent[]): string[] {
  const lines: string[] = [`${title}（${events.length} 件）:`];
  if (events.length === 0) { lines.push('  該当なし'); return lines; }
  let totalCandidates = 0;
  const failureCounts: Partial<Record<FailureCode, number>> = {};
  const dReasonCounts: Partial<Record<DFailureReason, number>> = {};
  for (const event of events) {
    if (event.failedAt) {
      failureCounts[event.failedAt] = (failureCounts[event.failedAt] ?? 0) + 1;
      if (event.failedAt === 'd') {
        const reasons = event.dReasons.length > 0 ? event.dReasons : (['no-held'] as DFailureReason[]);
        for (const reason of reasons) dReasonCounts[reason] = (dReasonCounts[reason] ?? 0) + 1;
        const reasonText = [...new Set(reasons)].map((reason) => D_REASON_LABELS[reason]).join('、');
        lines.push(`  run=${event.runLabel}/${event.runId} trial=${event.trialIndex}: 候補 0 件（落ちた条件: d／${reasonText}）`);
      } else {
        lines.push(`  run=${event.runLabel}/${event.runId} trial=${event.trialIndex}: 候補 0 件（落ちた条件: ${FAILURE_LABELS[event.failedAt]}）`);
      }
    } else {
      totalCandidates += event.candidates.length;
      const terms = event.candidates.map((c) => `${c.blockId}:${c.removedTerm}`).join(', ');
      lines.push(`  run=${event.runLabel}/${event.runId} trial=${event.trialIndex}: 候補 ${event.candidates.length} 件作成（${terms}）`);
    }
  }
  const succeeded = events.filter((e) => e.failedAt === null).length;
  const failureSummary = Object.entries(failureCounts).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code}=${count}`).join('、') || 'なし';
  lines.push(`  合計: 候補 ${totalCandidates} 件作成（run 内の重複を排除していない延べ数）、`
    + `成功 ${succeeded}/${events.length}、失敗内訳: ${failureSummary}`);
  if (Object.keys(dReasonCounts).length > 0) {
    const dBreakdown = (Object.entries(dReasonCounts) as [DFailureReason, number][])
      .sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${D_REASON_LABELS[reason]}=${count}`).join('、');
    lines.push(`  d の内訳: ${dBreakdown}`);
  }
  return lines;
}

interface CandidateOccurrence { runId: string; best: BestState; candidate: CreatedCandidate }

function collectOccurrences(events: DuplicationEvent[]): CandidateOccurrence[] {
  return events.flatMap((event) => event.candidates.map((candidate) => ({ runId: event.runId, best: event.best, candidate })));
}

/**
 * `runId` + 候補の fingerprint で重複排除する。同じ run 内で差し戻し前後の複数のイベントが
 * 同じ held 候補を参照すると、まったく同じ候補が何度も作られる
 * （実測: run `...693f7bbe` の trial 3/4/5/6 はすべて同じ 4 候補を指す）。
 */
function dedupeOccurrences(occurrences: CandidateOccurrence[]): CandidateOccurrence[] {
  const seen = new Map<string, CandidateOccurrence>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.runId}:${occurrence.candidate.fingerprint}`;
    if (!seen.has(key)) seen.set(key, occurrence);
  }
  return [...seen.values()];
}

function renderContributionBreakdown(title: string, occurrences: CandidateOccurrence[]): string[] {
  const buckets: Record<ContributionBucket, number> = {
    '0件': 0, '1〜100件': 0, '101〜1,000件': 0, '1,000件超': 0, '不明': 0,
  };
  for (const { best, candidate } of occurrences) {
    buckets[classifyContribution(best, candidate.blockId, candidate.removedTerm)]++;
  }
  const lines: string[] = [`${title}（${occurrences.length} 件）の finalContribution 区分:`];
  for (const key of ['0件', '1〜100件', '101〜1,000件', '1,000件超', '不明'] as ContributionBucket[]) {
    lines.push(`  ${key}: ${buckets[key]}`);
  }
  return lines;
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  if (report.skippedFileCount > 0) {
    lines.push(`※ 自動調整以外の形式の run.json を ${report.skippedFileCount} 件読み飛ばしました。`, '');
  }
  lines.push('=== 第 1 節: 再現ゲート ===', '');
  for (const section of report.section1) { lines.push(...renderSection1(section)); lines.push(''); }

  // 差し戻しの試行自体は評価試行・改善なし回数を消費しないため、
  // bucket==='no-resubmission'（直前の試行が差し戻しではない＝この重複が最初の検出）は
  // 「この試行自体が差し戻しの引き金になった」ものと「差し戻しも経ずに直接 no_improvement へ
  // 計上された」ものを区別して数える必要がある。
  const reDuplication = report.events.filter((e) => e.bucket === 'resubmission');
  const firstDetection = report.events.filter((e) => e.bucket === 'no-resubmission');
  const firstDetectionTriggeredResubmission = firstDetection.filter((e) => e.selfResubmissionRequested);
  const firstDetectionBypassed = firstDetection.filter((e) => !e.selfResubmissionRequested);

  lines.push('=== 第 2 節: 実現可能性 ===', '');
  lines.push(...renderEventGroup('再重複（差し戻し後にまた重複だった回）', reDuplication));
  lines.push('');
  lines.push(...renderEventGroup(
    '初回の重複（＝差し戻しの引き金になった試行そのもの。この時点ではまだ評価試行・改善なし回数を消費しない）',
    firstDetectionTriggeredResubmission,
  ));
  lines.push('');
  lines.push(...renderEventGroup(
    '差し戻しを経ずに改善なしへ直接計上された重複（この試行自体は resubmissionRequested を立てていない）',
    firstDetectionBypassed,
  ));
  lines.push('');

  lines.push('=== 第 3 節: 順位付けデータの有無 ===', '');
  lines.push('※ 以下「再重複」「初回の重複」の内訳は run 内の重複を排除していない延べ数（同じ候補を');
  lines.push('  複数イベントで重ねて数えている）。「合計（重複排除）」欄だけが runId + fingerprint で');
  lines.push('  重複排除した実際のユニーク候補数。');
  lines.push(...renderContributionBreakdown('再重複からの候補（延べ数）', collectOccurrences(reDuplication)));
  lines.push('');
  lines.push(...renderContributionBreakdown('初回の重複からの候補（延べ数）', collectOccurrences(firstDetection)));
  lines.push('');
  lines.push(...renderContributionBreakdown('合計（重複排除）', dedupeOccurrences(collectOccurrences(report.events))));
  lines.push('');

  lines.push('※ この集計は候補を作れたかどうかだけを数えたものであり、作れた候補が実測で採用・保留に',
    '  なったかは一切示さない（実測していないため）。');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dir: string; label?: string } {
  const usage = '使い方: npm run eval:partial-deletion -- <results ディレクトリ> [--label <ラベル>]';
  const positionals: string[] = [];
  let label: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--label') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(usage);
      label = value;
      index++;
    } else {
      positionals.push(argv[index]!);
    }
  }
  if (positionals.length !== 1) throw new Error(usage);
  return { dir: positionals[0]!, label };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { dir, label } = parseArgs(argv);
  if (!existsSync(dir)) throw new Error(`ディレクトリが存在しません: ${dir}`);
  const report = await buildReport(dir, label);
  process.stdout.write(renderReport(report));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}
