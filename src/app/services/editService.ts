import { appendFormulaVersion, getFormulaVersionById } from '@/features/formula';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import type { GoogleApiDeps } from '@/lib/google';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
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

async function resolveProtocolContext(
  deps: EditServiceDeps
): Promise<{ protocolVersion: number; protocolSnapshotRef: string }> {
  const state = deps.store.getState();
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
