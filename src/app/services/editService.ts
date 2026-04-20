import {
  appendFormulaVersion,
  getFormulaVersionById,
  improveBlockExpression,
  type ImproveBlockProposal,
} from '@/features/formula';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
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

export interface RequestBlockImprovementInput {
  /** 改善対象のブロック ID（例: `"1"`, `"RCTfilter"`） */
  blockId: string;
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
  llmFactory: LlmProviderFactory;
}

/**
 * 指定ブロックに対して improve-block skill を走らせ、新しい expression 案を返す。
 * store は書き換えない（diff を見せてから accept / reject をユーザーに選ばせるため）。
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
  const formula = parsePubmedFormulaMd(state.currentFormulaMarkdown);
  const target = formula.blocks.find((b) => b.id === input.blockId);
  if (!target) {
    throw new Error(`ブロック #${input.blockId} が見つかりません`);
  }
  const blockContext = findBlockContext(deps.store, target.id);
  const provider = deps.llmFactory.forPurpose('improve_block');
  const proposal: ImproveBlockProposal = await improveBlockExpression(
    {
      currentExpression: target.expression,
      blockLabel: blockContext.label,
      blockDescription: blockContext.description,
      researchQuestion: state.protocolDraft?.researchQuestion ?? '',
    },
    provider
  );
  return {
    blockId: target.id,
    currentExpression: target.expression,
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
