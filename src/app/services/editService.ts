import {
  appendFormulaVersion,
  getFormulaVersionById,
  improveBlockExpression,
  type ImproveBlockProposal,
} from '@/features/formula';
import { listSeedPapersWithRows } from '@/features/seeds';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import { extractBlockReferences, parsePubmedFormulaMd } from '@/lib/search-formula-md';
import type { GoogleApiDeps } from '@/lib/google';
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
      // 手編集では AI を使わないので、元ドラフトを支援したモデルをそのまま引き継ぐ
      model: state.currentFormulaModel,
    },
    deps.google
  );

  deps.store.setState((s) => ({
    ...s,
    currentFormulaVersionId: versionId,
    currentFormulaMarkdown: input.formulaMd,
    currentFormulaCreatedBy: 'user_edit',
  }));

  return { versionId, parentVersionId };
}

/**
 * ブロック・インスペクタ（src/app/views/blockInspector.ts）が計測したキーワード 1 語ぶんの
 * ヒット数。improveBlockExpression の KeywordHitContext と同じ形（構造的に代入可能）だが、
 * サービス層が views 層の型へ依存しないよう、この層自身の宣言として持つ（issue #58 chunk 3c。
 * SeedContextEntry / ValidationContext と同じ理由）。
 */
export interface MeasuredKeywordHit {
  term: string;
  kind: 'mesh' | 'freeword';
  /** 単体 esearch ヒット数。未計測なら null */
  hits: number | null;
  /** フリーワードのみ: 個別降順で OR 累積したときの純増（Δ）。MeSH・未計測は null */
  delta?: number | null;
  /** フリーワードのみ: 寄与区分（normal / lowYield / redundant）。MeSH・未計測は null */
  status?: 'normal' | 'lowYield' | 'redundant' | null;
}

export interface RequestBlockImprovementInput {
  /** 改善対象のブロック ID（例: `"1"`, `"RCTfilter"`） */
  blockId: string;
  /** ユーザーが任意で書いた改善指示。空文字なら「おまかせ」改善 */
  instruction?: string;
  /**
   * ブロック・インスペクタが計測済みの、このブロック式全体のヒット数（issue #58 chunk 3c）。
   * インスペクタは個々の語（MeSH・フリーワード）の単体ヒット数しか計測しないため、
   * 現状 editView から渡ることはない（常に省略＝未計測扱い）。将来ブロック全体のヒット数を
   * 計測する経路ができたときのための受け口として残す。
   */
  currentHits?: number | null;
  /** ブロック・インスペクタが計測済みのキーワード別ヒット数。未計測・インスペクタ未展開なら省略 */
  keywordHits?: MeasuredKeywordHit[];
  /** ブロック・インスペクタが計測済みのフリーワード OR 合計（重複除去後）。未計測なら省略 */
  freewordDedupTotal?: number | null;
  /**
   * 兄弟ブロック（結合行を除く他の概念ブロック）のうち、自分の式と語を共有しているもの
   * （issue #89）。「#1 と重複するキーワードを消して」のような指示を AI が根拠を持って
   * 実行できるよう、editView.ts の computeSiblingOverlaps（views 層）が計算した結果を
   * そのまま渡す。空・未計測なら省略。
   */
  siblings?: SiblingBlockContext[];
}

/**
 * ブロック・インスペクタ（src/app/views/blockInspector.ts）が計算した、兄弟ブロック 1 件との
 * 共有語。SiblingOverlap（views 層）と同じ形（構造的に代入可能）だが、サービス層が views 層の
 * 型へ依存しないよう、この層自身の宣言として持つ（MeasuredKeywordHit と同じ理由。issue #89）。
 */
export interface SiblingBlockContext {
  id: string;
  label: string | null;
  expression: string;
  sharedTerms: string[];
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

/**
 * AI 改善に渡る文脈のスナップショット。/edit 画面で「AI に渡す内容を見る」を
 * 開いたときに表示するためのもの。requestBlockImprovement と同じ抽出ロジックを使う。
 */
export interface BlockImprovementContext {
  researchQuestion: string;
  blockLabel: string;
  blockDescription: string;
  currentExpression: string;
  /** 検証対象になりうるシード論文（include 判定 + 初期登録の未判定）。対話拡張分も含む */
  seedPapers: SeedContextEntry[];
  /** 直近の検証で得た捕捉情報。現バージョンと一致する結果のみ。なければ null */
  validation: ValidationContext | null;
  /** 呼び出し元（editView）から渡された、共有語を持つ兄弟ブロック（issue #89）。空なら空配列 */
  siblings: SiblingBlockContext[];
}

/** プロンプト肥大化を防ぐためのシード件数上限 */
const MAX_SEED_CONTEXT = 40;
/** captured / missed PMID の表示上限 */
const MAX_PMID_CONTEXT = 50;

export interface BlockImprovementContextDeps {
  store: AppStore;
  google: GoogleApiDeps;
}

/**
 * 指定ブロックについて、AI 改善時にプロンプトへ載る文脈を組み立てて返す。
 * 副作用なし（SeedPapers タブの読み取りのみ）。requestBlockImprovement と
 * 「AI に渡す内容を見る」開示の双方が同じ文脈を共有するための単一ビルダー。
 *
 * siblings（他ブロックとの共有語）はここでは計算しない。views 層
 * （blockInspector.ts の computeSiblingOverlaps）が計算した結果をそのまま受け取って
 * context へ載せるだけ（issue #89。サービス層が views 層の計算ロジックへ依存しないため）。
 *
 * @returns ブロックが見つからない、または式が未生成なら null
 */
export async function getBlockImprovementContext(
  blockId: string,
  siblings: SiblingBlockContext[],
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
  return {
    researchQuestion: state.protocolDraft?.researchQuestion ?? '',
    blockLabel: blockContext.label,
    blockDescription: blockContext.description,
    currentExpression: target.expression,
    seedPapers,
    validation: collectValidationContext(deps.store),
    siblings,
  };
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
  const context = await getBlockImprovementContext(input.blockId, input.siblings ?? [], {
    store: deps.store,
    google: deps.google,
  });
  if (context === null) {
    throw new Error(`ブロック #${input.blockId} が見つかりません`);
  }
  const provider = deps.llmFactory.forPurpose('improve_block');
  const proposal: ImproveBlockProposal = await improveBlockExpression(
    {
      currentExpression: context.currentExpression,
      // インスペクタが計測済みのヒット数（issue #58 chunk 3c）。渡し手は editView（AI 改善の
      // submit 時に blockInspector.collectMeasuredContext で読んだ値）。ここでは受け取った
      // input をそのまま improve-block skill の入力へ転記するだけで、ここで計測はしない
      // （NCBI へのリクエストを増やさないため）。
      currentHits: input.currentHits,
      keywordHits: input.keywordHits,
      freewordDedupTotal: input.freewordDedupTotal,
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
      // 他ブロックとの共有語（issue #89）。「#1 と重複するキーワードを消して」のような指示を
      // 根拠なしの推測にさせないための文脈。
      siblingBlocks: context.siblings,
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
 * この関数は AI 改善の accept・チップ編集・クイック整理・インスペクタからの編集・
 * 生テキスト詳細編集のすべてが通る唯一の適用口（issue #88）。差し替えで
 * 「他ブロックへの参照」を失う・新たに混入する操作は {@link assertReferenceIntegrity}
 * が拒否するため、ここに入れることで全ての編集経路が参照整合性を守る。
 *
 * @throws {Error} 指定 blockId が見つからない、式が空、または参照整合性が崩れる場合
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
  const trimmedNew = newExpression.trim();
  if (trimmedNew === '') {
    throw new Error(`ブロック #${blockId} を空にすることはできません。`);
  }
  assertReferenceIntegrity(formulaMd, blockId, trimmedNew);
  const replacement = `#${blockId} ${trimmedNew}`;
  return formulaMd.replace(lineRegex, replacement);
}

/**
 * 置換前後で「他ブロックへの参照」を失う・新たに混入する操作を拒否する（issue #88）。
 *
 * `#3 #1 AND #2` のような掛け合わせ行は参照が消えると
 * `expandFormula.ts` の `chooseEntryBlockId` が「結合行なし → 最後の行」に
 * フォールバックし、#1/#2 が効いていない式のまま捕捉率が計算・エクスポートされてしまう
 * （ユーザーからは見えない）。逆に概念ブロックへ参照を混入させると意図しない結合行が
 * 生まれる。
 *
 * 置換前・置換後の両方に参照がある（掛け合わせの構造自体を書き換える）場合は許可する
 * （構造編集 UI は issue #91 で扱う）。
 *
 * `parsePubmedFormulaMd` が失敗する（パース不能な md）場合はガードをスキップし、
 * 従来どおり置換する（既存の逃げ道を塞がない）。
 */
function assertReferenceIntegrity(
  formulaMd: string,
  blockId: string,
  newExpression: string
): void {
  let formula;
  try {
    formula = parsePubmedFormulaMd(formulaMd);
  } catch {
    return;
  }
  const target = formula.blocks.find((b) => b.id === blockId);
  if (target === undefined) {
    return;
  }
  const knownIds = new Set(formula.blocks.map((b) => b.id));
  const beforeRefs = extractBlockReferences(target.expression, blockId, knownIds);
  const afterRefs = extractBlockReferences(newExpression, blockId, knownIds);

  if (beforeRefs.length > 0 && afterRefs.length === 0) {
    throw new Error(
      `ブロック #${blockId} は他のブロックを掛け合わせる行です（${formatRefs(beforeRefs)} を参照）。この操作で参照が失われるため適用できません。語の編集は各ブロックで行ってください。`
    );
  }
  if (beforeRefs.length === 0 && afterRefs.length > 0) {
    throw new Error(
      `ブロック #${blockId} に他のブロックへの参照（${formatRefs(afterRefs)}）を含めることはできません。`
    );
  }
}

function formatRefs(ids: string[]): string {
  return ids.map((id) => `#${id}`).join(', ');
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
