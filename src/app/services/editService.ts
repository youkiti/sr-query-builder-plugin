import {
  appendFormulaVersion,
  getFormulaVersionById,
  improveBlockExpression,
  updateFormulaVersion,
  type ImproveBlockProposal,
} from '@/features/formula';
import { listSeedPapers, listSeedPapersWithRows } from '@/features/seeds';
import {
  analyzeFreewordDelta,
  checkFinalQuery,
  type FinalQueryResult,
} from '@/features/validation';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import type { FormulaVersion } from '@/domain/formulaVersion';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { deriveKeywordQueries } from '../views/formulaDisplay';
import type { GoogleApiDeps } from '@/lib/google';
import type { EutilsDeps } from '@/lib/ncbi';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import type { LlmProviderFactory } from './llmProviderService';
import type { AppStore } from '../store';

/**
 * /edit 画面で手編集された formula_md を新しい FormulaVersion として保存するサービス。
 *
 * - 現在の currentFormulaVersionId を parent_version_id に設定
 * - createdBy は常に 'user_edit'
 * - 保存前に parsePubmedFormulaMd でパース検証し、失敗なら例外
 * - 成功時は store.currentFormulaVersionId / currentFormulaMarkdown を新版で上書き
 */

export interface EditServiceDeps {
  google: GoogleApiDeps;
  store: AppStore;
  newUuid?: () => string;
  now?: () => string;
}

export interface SaveEditedFormulaInput {
  /** 編集後の formula_md 全文（`## PubMed/MEDLINE` セクションを含む） */
  formulaMd: string;
  /** ユーザー記入の編集メモ。空文字なら null 保存 */
  note: string;
}

export interface SaveEditedFormulaResult {
  versionId: string;
  parentVersionId: string | null;
}

export async function saveEditedFormula(
  input: SaveEditedFormulaInput,
  deps: EditServiceDeps
): Promise<SaveEditedFormulaResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  const trimmed = input.formulaMd.trim();
  if (trimmed === '') {
    throw new Error('検索式が空です');
  }
  // フォーマット妥当性をパースで検証。失敗時は FormulaParseError が投げられる。
  parsePubmedFormulaMd(input.formulaMd);

  const versionId = (deps.newUuid ?? newUuid)();
  const createdAt = (deps.now ?? nowIso)();
  const parentVersionId = state.currentFormulaVersionId;
  const protocolContext = await resolveProtocolContext(deps);

  await appendFormulaVersion(
    state.project.spreadsheetId,
    {
      versionId,
      parentVersionId,
      protocolVersion: protocolContext.protocolVersion,
      protocolSnapshotRef: protocolContext.protocolSnapshotRef,
      formulaMd: input.formulaMd,
      createdBy: 'user_edit',
      createdAt,
      note: input.note.trim() === '' ? null : input.note.trim(),
    },
    deps.google
  );

  deps.store.setState((s) => ({
    ...s,
    currentFormulaVersionId: versionId,
    currentFormulaMarkdown: input.formulaMd,
  }));

  return { versionId, parentVersionId };
}

export interface OverwriteFormulaInput {
  /** 上書き後の formula_md 全文（`## PubMed/MEDLINE` セクションを含む） */
  formulaMd: string;
}

export interface OverwriteFormulaResult {
  /** 上書きした（または新規作成した）バージョン ID */
  versionId: string;
  /** 既存行を上書きしたら false、対象が無く新規追記にフォールバックしたら true */
  created: boolean;
}

/**
 * #/edit の作業バージョンを「動的保存（上書き）」する。
 *
 * - 現在の currentFormulaVersionId の行を `updateFormulaVersion` で同じ場所に上書きし、
 *   created_by='user_edit' / created_at=now に更新する（version_id は変えない＝履歴を増やさない）
 * - currentFormulaVersionId が無い（まだ 1 度も保存していない）場合は saveEditedFormula に
 *   フォールバックして新規 1 行を追記する
 * - 履歴を残したいときは別途 saveEditedFormula（「新バージョンとして保存」）を使う
 */
export async function overwriteCurrentFormula(
  input: OverwriteFormulaInput,
  deps: EditServiceDeps
): Promise<OverwriteFormulaResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (input.formulaMd.trim() === '') {
    throw new Error('検索式が空です');
  }
  // フォーマット妥当性をパースで検証（壊れた md を保存しない）。
  parsePubmedFormulaMd(input.formulaMd);

  const versionId = state.currentFormulaVersionId;
  if (versionId === null) {
    // 上書き対象が無いので新規追記にフォールバックする。
    const saved = await saveEditedFormula({ formulaMd: input.formulaMd, note: '' }, deps);
    return { versionId: saved.versionId, created: true };
  }

  const createdAt = (deps.now ?? nowIso)();
  const updated = await updateFormulaVersion(
    state.project.spreadsheetId,
    versionId,
    { formulaMd: input.formulaMd, createdBy: 'user_edit', createdAt },
    deps.google
  );
  if (!updated) {
    // version_id がシート上に見つからない（履歴削除など）の場合も追記でフォールバック。
    const saved = await saveEditedFormula({ formulaMd: input.formulaMd, note: '' }, deps);
    return { versionId: saved.versionId, created: true };
  }

  deps.store.setState((s) => ({ ...s, currentFormulaMarkdown: input.formulaMd }));
  return { versionId, created: false };
}

export interface RestoreFormulaResult {
  /** 復元後の作業バージョン ID（新規フォーク時は新 ID、現バージョン再読込なら同じ ID） */
  versionId: string;
  /** 復元元のバージョン ID */
  restoredFrom: string;
  /** 新しい作業バージョンを追記したら true、現バージョンの再読込なら false */
  created: boolean;
}

/**
 * #/history で選んだ過去バージョンを「復元」する。
 *
 * 動的上書き保存と両立させるため、復元は**元の履歴行を一切変更せず**、その内容を
 * コピーした**新しい作業バージョンを追記**して作業ポインタをそこへ移す（git revert 相当）。
 * こうすることで、復元後に #/edit で編集して自動上書きが走っても、復元元の履歴行は無傷で残る。
 *
 * - 新バージョン: parent_version_id=復元元 / created_by=user_edit / note=「復元元: {id}」
 * - 復元先が現在の作業バージョンと同じ場合はフォークせず、内容の読み込みだけ行う（no-op フォーク回避）
 */
export async function restoreFormulaVersion(
  version: FormulaVersion,
  deps: EditServiceDeps
): Promise<RestoreFormulaResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }

  // 既に作業中のバージョンなら、新しい行は作らず内容を読み込むだけにする。
  if (version.versionId === state.currentFormulaVersionId) {
    deps.store.setState((s) => ({
      ...s,
      currentProtocolVersion: version.protocolVersion,
      currentFormulaMarkdown: version.formulaMd,
      editAutoSave: null,
    }));
    return { versionId: version.versionId, restoredFrom: version.versionId, created: false };
  }

  const newVersionId = (deps.newUuid ?? newUuid)();
  const createdAt = (deps.now ?? nowIso)();
  await appendFormulaVersion(
    state.project.spreadsheetId,
    {
      versionId: newVersionId,
      parentVersionId: version.versionId,
      protocolVersion: version.protocolVersion,
      protocolSnapshotRef: version.protocolSnapshotRef,
      formulaMd: version.formulaMd,
      createdBy: 'user_edit',
      createdAt,
      note: `復元元: ${version.versionId}`,
    },
    deps.google
  );

  deps.store.setState((s) => ({
    ...s,
    currentProtocolVersion: version.protocolVersion,
    currentFormulaVersionId: newVersionId,
    currentFormulaMarkdown: version.formulaMd,
    editAutoSave: null,
  }));
  return { versionId: newVersionId, restoredFrom: version.versionId, created: true };
}

/**
 * /edit 画面の結合行（最終検索式）に対する「検索 + シード捕捉確認」結果。
 * checkFinalQuery（final_query 検証）をそのまま編集中の md に適用したもの。
 */
export interface CombinationCheckResult extends FinalQueryResult {
  /** 検証対象になった有効 seed 件数（include + 初期未判定） */
  eligibleSeedCount: number;
  /** SeedPapers の総件数（無効・除外含む） */
  totalSeedCount: number;
}

export interface CombinationCheckDeps {
  store: AppStore;
  google: GoogleApiDeps;
  eutils: EutilsDeps;
}

/**
 * 編集中の検索式 md の結合行（最終クエリ）を実際に PubMed 検索し、同時に有効シード論文が
 * 捕捉できているかを確認する（requirements.md §4.6 final_query の単発実行）。
 *
 * - Sheets への記録は行わない（保存前の編集中 md に対して何度でも押せる確認用）
 * - 引数の formulaMd は view が握っている編集中の md（store の currentFormulaMarkdown とは別物）
 *
 * @throws プロジェクト未選択、または md がパースできない場合
 */
export async function checkEditedCombination(
  formulaMd: string,
  deps: CombinationCheckDeps
): Promise<CombinationCheckResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  const formula = parsePubmedFormulaMd(formulaMd);
  const seeds = await listSeedPapers(state.project.spreadsheetId, deps.google);
  const eligible = seeds.filter((seed) => isSeedEligibleForValidation(seed));
  const eligiblePmids = eligible
    .map((seed) => seed.pmid)
    .filter((pmid): pmid is string => pmid !== null);
  const result = await checkFinalQuery(formula, eligiblePmids, deps.eutils);
  return {
    ...result,
    eligibleSeedCount: eligible.length,
    totalSeedCount: seeds.length,
  };
}

export interface RequestBlockImprovementInput {
  /** 改善対象のブロック ID（例: `"1"`, `"RCTfilter"`） */
  blockId: string;
  /** ユーザーが任意で書いた改善指示。空文字なら「おまかせ」改善 */
  instruction?: string;
}

/** AI 改善文脈に載せるシード論文 1 件。 */
export interface SeedContextEntry {
  pmid: string;
  title: string;
  /** include / maybe / initial 等。対話拡張で追加されたものは source=interactive */
  decision: string;
  source: 'initial' | 'interactive';
}

/** 直近の検証で得た捕捉情報（現バージョンの結果のみ）。 */
export interface ValidationContext {
  captureRate: number;
  capturedPmids: string[];
  missedPmids: string[];
}

/** キーワード 1 語の単体ヒット数 + 寄与情報（AI 文脈・開示用）。 */
export interface KeywordHitEntry {
  term: string;
  kind: 'mesh' | 'freeword';
  /** 単体 esearch ヒット数。計測失敗・未注入時は null */
  hits: number | null;
  /**
   * フリーワードのみ: 個別ヒット数の多い順に OR で累積したときの純増（Δ）。インスペクタの Δ 表と同じ。
   * MeSH・計測不可時は null。
   */
  delta: number | null;
  /**
   * フリーワードのみ: 寄与区分（normal=相応に寄与 / lowYield=ほぼ寄与なし / redundant=他語に内包＝削除候補）。
   * MeSH・計測不可時は null。
   */
  status: 'normal' | 'lowYield' | 'redundant' | null;
}

/** プロンプト肥大化を防ぐためのキーワード件数上限 */
const MAX_KEYWORD_CONTEXT = 60;

/**
 * AI 改善に渡る文脈のスナップショット。/edit 画面で「AI に渡す内容を見る」を
 * 開いたときに表示するためのもの。requestBlockImprovement と同じ抽出ロジックを使う。
 */
export interface BlockImprovementContext {
  researchQuestion: string;
  blockLabel: string;
  blockDescription: string;
  currentExpression: string;
  /**
   * 現在の expression を PubMed で実検索したヒット数（esearch count）。画面のヒット数バッジと
   * 同じ実数。結合行・未注入・計測失敗時は null（AI 文脈・開示の双方で「未計測」扱い）。
   */
  currentHits: number | null;
  /**
   * 式を構成するキーワード（MeSH / フリーワード）ごとの単体ヒット数 + フリーワードの寄与（Δ・区分）。
   * 編集画面のインスペクタと同じ計測（同一キャッシュ）。結合行・未注入時は空配列。
   */
  keywordHits: KeywordHitEntry[];
  /** フリーワードを OR で結合し重複除去した合計ヒット数（インスペクタの「tiab 合計」）。無ければ null */
  freewordDedupTotal: number | null;
  /** 検証対象になりうるシード論文（include 判定 + 初期登録の未判定）。対話拡張分も含む */
  seedPapers: SeedContextEntry[];
  /** 直近の検証で得た捕捉情報。現バージョンと一致する結果のみ。なければ null */
  validation: ValidationContext | null;
}

/** プロンプト肥大化を防ぐためのシード件数上限 */
const MAX_SEED_CONTEXT = 40;
/** captured / missed PMID の表示上限 */
const MAX_PMID_CONTEXT = 50;

export interface BlockImprovementContextDeps {
  store: AppStore;
  google: GoogleApiDeps;
  /**
   * 概念ブロックの式を実検索してヒット数を返す（esearch count）。画面のヒット数バッジと
   * 同じ計測を共有するため、bootstrap が同一キャッシュ越しに注入する。未注入なら currentHits=null。
   */
  countHits?: (expression: string) => Promise<number>;
}

/**
 * 指定ブロックについて、AI 改善時にプロンプトへ載る文脈を組み立てて返す。
 * 副作用なし（SeedPapers タブの読み取りのみ）。requestBlockImprovement と
 * 「AI に渡す内容を見る」開示の双方が同じ文脈を共有するための単一ビルダー。
 *
 * @returns ブロックが見つからない、または式が未生成なら null
 */
export async function getBlockImprovementContext(
  blockId: string,
  deps: BlockImprovementContextDeps
): Promise<BlockImprovementContext | null> {
  const state = deps.store.getState();
  if (state.currentFormulaMarkdown === null || state.currentFormulaMarkdown.trim() === '') {
    return null;
  }
  let formula;
  try {
    formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  } catch {
    return null;
  }
  const target = formula.blocks.find((b) => b.id === blockId);
  if (!target) {
    return null;
  }
  const blockContext = findBlockContext(deps.store, target.id);
  const seedPapers = await collectSeedContext(deps);
  const [currentHits, keywords] = await Promise.all([
    collectCurrentHits(target.expression, target.isCombination, deps),
    collectKeywordHits(target.expression, target.isCombination, deps),
  ]);
  return {
    researchQuestion: state.protocolDraft?.researchQuestion ?? '',
    blockLabel: blockContext.label,
    blockDescription: blockContext.description,
    currentExpression: target.expression,
    currentHits,
    keywordHits: keywords.entries,
    freewordDedupTotal: keywords.freewordDedupTotal,
    seedPapers,
    validation: collectValidationContext(deps.store),
  };
}

/**
 * ブロック式を構成するキーワードごとの単体ヒット数 + フリーワードの寄与（Δ・区分）を集める。
 * クエリ・累積 OR の式は blockInspector と同じなので、編集画面で計測済みのキャッシュを再利用する
 * （= 改めて全件 esearch しない）。MeSH は個別件数、フリーワードは analyzeFreewordDelta で
 * Δ（純増）と区分（削除候補 / ほぼ寄与なし）まで求める。結合行・countHits 未注入なら空。
 * 計測失敗時も改善は続けたいので、失敗語は hits=null・Δ=null にして他語は活かす。
 */
async function collectKeywordHits(
  expression: string,
  isCombination: boolean,
  deps: BlockImprovementContextDeps
): Promise<{ entries: KeywordHitEntry[]; freewordDedupTotal: number | null }> {
  if (isCombination || deps.countHits === undefined) {
    return { entries: [], freewordDedupTotal: null };
  }
  const countHits = deps.countHits;
  const keywords = deriveKeywordQueries(expression);
  const meshKeywords = keywords.filter((k) => k.kind === 'mesh');
  const freewordKeywords = keywords.filter((k) => k.kind === 'freeword');

  // MeSH: 個別件数のみ（Δ 分析はフリーワード専用）。
  const meshEntries = await Promise.all(
    meshKeywords.map(async (kw): Promise<KeywordHitEntry> => {
      try {
        return { term: kw.display, kind: 'mesh', hits: await countHits(kw.query), delta: null, status: null };
      } catch {
        return { term: kw.display, kind: 'mesh', hits: null, delta: null, status: null };
      }
    })
  );

  // フリーワード: Δ（純増）と区分まで。インスペクタと同じ累積 OR クエリでキャッシュを共有する。
  let freewordEntries: KeywordHitEntry[] = [];
  let freewordDedupTotal: number | null = null;
  if (freewordKeywords.length > 0) {
    try {
      const delta = await analyzeFreewordDelta(
        freewordKeywords.map((k) => ({ display: k.display, query: k.query })),
        countHits
      );
      freewordDedupTotal = delta.totalDeduped;
      freewordEntries = delta.rows.map((r) => ({
        term: r.display,
        kind: 'freeword',
        hits: r.individual,
        delta: r.delta,
        status: r.status,
      }));
    } catch {
      // Δ 計算が失敗したら個別件数だけでフォールバックする。
      freewordEntries = await Promise.all(
        freewordKeywords.map(async (kw): Promise<KeywordHitEntry> => {
          try {
            return { term: kw.display, kind: 'freeword', hits: await countHits(kw.query), delta: null, status: null };
          } catch {
            return { term: kw.display, kind: 'freeword', hits: null, delta: null, status: null };
          }
        })
      );
    }
  }

  const entries = [...meshEntries, ...freewordEntries].slice(0, MAX_KEYWORD_CONTEXT);
  return { entries, freewordDedupTotal };
}

/**
 * 概念ブロックの式を実検索してヒット数を返す。結合行（#N 参照を含む）は単体検索できないので
 * 計測しない。countHits 未注入・計測失敗時も改善自体は続けたいので null を返す。
 */
async function collectCurrentHits(
  expression: string,
  isCombination: boolean,
  deps: BlockImprovementContextDeps
): Promise<number | null> {
  if (isCombination || deps.countHits === undefined) {
    return null;
  }
  try {
    return await deps.countHits(expression);
  } catch {
    return null;
  }
}

/**
 * SeedPapers タブから「検証対象になりうる」シード（include / 初期未判定）を取り出し、
 * 対話拡張で追加された interactive シードも含めて文脈用エントリに整形する。
 * Sheets 読み取りに失敗しても改善自体は続けたいので、その場合は空配列を返す。
 */
async function collectSeedContext(
  deps: BlockImprovementContextDeps
): Promise<SeedContextEntry[]> {
  const state = deps.store.getState();
  if (state.project === null) {
    return [];
  }
  let rows;
  try {
    rows = await listSeedPapersWithRows(state.project.spreadsheetId, deps.google);
  } catch {
    return [];
  }
  return rows
    .map((r) => r.seed)
    .filter((s) => isSeedEligibleForValidation(s) && s.pmid !== null)
    .slice(0, MAX_SEED_CONTEXT)
    .map((s) => ({
      pmid: s.pmid as string,
      title: s.title ?? '(タイトル不明)',
      decision: s.userDecision ?? '(未判定)',
      source: s.source,
    }));
}

/**
 * 直近の検証結果のうち、現在の formula バージョンと一致するものだけを返す。
 * stale な（別バージョンの）結果は AI を誤誘導するので使わない。
 */
function collectValidationContext(store: AppStore): ValidationContext | null {
  const state = store.getState();
  const vr = state.validationResult;
  if (vr === null || state.currentFormulaVersionId === null) {
    return null;
  }
  if (vr.formulaVersionId !== state.currentFormulaVersionId) {
    return null;
  }
  const fq = vr.summary.finalQuery;
  return {
    captureRate: fq.captureRate,
    capturedPmids: fq.capturedPmids.slice(0, MAX_PMID_CONTEXT),
    missedPmids: fq.missedPmids.slice(0, MAX_PMID_CONTEXT),
  };
}

export interface BlockImprovementResult {
  blockId: string;
  /** 改善前の expression（formula_md から抽出したもの） */
  currentExpression: string;
  /** LLM の提案 expression */
  proposedExpression: string;
  /** 提案の改善ポイント（日本語） */
  rationale: string;
}

export interface BlockImprovementDeps {
  store: AppStore;
  google: GoogleApiDeps;
  llmFactory: LlmProviderFactory;
  /** 概念ブロックの式を実検索してヒット数を返す（esearch count）。未注入なら currentHits は省略。 */
  countHits?: (expression: string) => Promise<number>;
}

/**
 * 指定ブロックに対して improve-block skill を走らせ、新しい expression 案を返す。
 * store は書き換えない（diff を見せてから accept / reject をユーザーに選ばせるため）。
 *
 * 文脈（RQ / ブロック定義 / シード論文 / 直近の検証捕捉情報）は
 * getBlockImprovementContext と同じビルダーで組み立て、「AI に渡す内容を見る」開示と
 * 実際にプロンプトへ載る内容が一致するようにする。
 *
 * @throws {Error} currentFormulaMarkdown が空、または blockId が見つからない場合
 */
export async function requestBlockImprovement(
  input: RequestBlockImprovementInput,
  deps: BlockImprovementDeps
): Promise<BlockImprovementResult> {
  const state = deps.store.getState();
  if (state.currentFormulaMarkdown === null || state.currentFormulaMarkdown.trim() === '') {
    throw new Error('検索式がまだ生成されていません');
  }
  const context = await getBlockImprovementContext(input.blockId, {
    store: deps.store,
    google: deps.google,
    countHits: deps.countHits,
  });
  if (context === null) {
    throw new Error(`ブロック #${input.blockId} が見つかりません`);
  }
  const provider = deps.llmFactory.forPurpose('improve_block');
  const proposal: ImproveBlockProposal = await improveBlockExpression(
    {
      currentExpression: context.currentExpression,
      currentHits: context.currentHits,
      keywordHits: context.keywordHits,
      freewordDedupTotal: context.freewordDedupTotal,
      blockLabel: context.blockLabel,
      blockDescription: context.blockDescription,
      researchQuestion: context.researchQuestion,
      userInstruction: input.instruction ?? '',
      seedPapers: context.seedPapers.map((s) => ({
        pmid: s.pmid,
        title: s.title,
        decision: s.decision,
      })),
      validation: context.validation,
    },
    provider
  );
  return {
    blockId: input.blockId,
    currentExpression: context.currentExpression,
    proposedExpression: proposal.proposedExpression,
    rationale: proposal.rationale,
  };
}

/**
 * 現在の formula_md の #N 行を新しい expression で差し替えた新しい Markdown を返す。
 * 保存は行わず、textarea に書き戻すだけなので副作用は無い。
 *
 * @throws {Error} 指定 blockId が見つからない
 */
export function applyBlockImprovement(
  formulaMd: string,
  blockId: string,
  newExpression: string
): string {
  const lineRegex = new RegExp(`^#${escapeRegex(blockId)}\\s+.+$`, 'm');
  if (!lineRegex.test(formulaMd)) {
    throw new Error(`ブロック #${blockId} の行が formula_md に見つかりません`);
  }
  const replacement = `#${blockId} ${newExpression.trim()}`;
  return formulaMd.replace(lineRegex, replacement);
}

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * store の blocksDraft から当該ブロックの label / description を探す。
 * blocksDraft はユーザーが承認したブロックの並び順で入っているので、
 * 数値 ID（`"1"` 〜）を 1-indexed として使う。
 * 数値でないブロック ID（例: `RCTfilter`）や、blocksDraft 外の ID では空文字を返す。
 */
function findBlockContext(
  store: AppStore,
  blockId: string
): { label: string; description: string } {
  const draft = store.getState().blocksDraft;
  if (draft === null) {
    return { label: '', description: '' };
  }
  const asNumber = Number.parseInt(blockId, 10);
  if (!Number.isFinite(asNumber) || asNumber < 1) {
    return { label: '', description: '' };
  }
  const entry = draft.blocks[asNumber - 1];
  if (entry === undefined) {
    return { label: '', description: '' };
  }
  return { label: entry.blockLabel, description: entry.description };
}

async function resolveProtocolContext(
  deps: EditServiceDeps
): Promise<{ protocolVersion: number; protocolSnapshotRef: string }> {
  const state = deps.store.getState();
  /* istanbul ignore if -- saveEditedFormula が呼び出し前に project を検証済み */
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (state.currentFormulaVersionId) {
    const currentVersion = await getFormulaVersionById(
      state.project.spreadsheetId,
      state.currentFormulaVersionId,
      deps.google
    );
    if (currentVersion !== null) {
      return {
        protocolVersion: currentVersion.protocolVersion,
        protocolSnapshotRef: currentVersion.protocolSnapshotRef,
      };
    }
  }
  if (state.protocolDraft === null) {
    throw new Error('protocolDraft が未設定です。プロトコル入力を先に行ってください');
  }
  return {
    protocolVersion: state.currentProtocolVersion ?? 0,
    protocolSnapshotRef: state.protocolDraft.rawTextRef ?? state.protocolDraft.rawTextInline ?? '',
  };
}
