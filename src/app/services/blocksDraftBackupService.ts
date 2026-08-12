import type { ProjectStoreDeps } from '@/features/project';
import { nowIso } from '@/utils/iso8601';
import type { BlocksDraft } from '../store';

/**
 * ブロック承認画面の「下書きとして保存」の永続化（fix-plan 1-2）。
 *
 * blocksDraft は in-memory のみでリロードで消えるため、承認前の編集を
 * `chrome.storage.local`（currentProject と同じ層）へ退避する。
 * - 保存単位は 1 件のみ（最後に保存した下書きが正）。projectId を持たせ、
 *   別プロジェクトのバックアップは復元時に無視する
 * - 承認（approveBlocks）とプロトコル再解析（submitProtocol）で破棄する。
 *   したがって「バックアップが存在する = 未承認の編集がある」と解釈できる
 */

const BACKUP_KEY = 'blocksDraftBackup';

export interface BlocksDraftBackup {
  projectId: string;
  /** 保存時刻（ISO 8601）。blocksView の未承認バナー表示に使う */
  savedAt: string;
  draft: BlocksDraft;
}

/** 下書きを保存し、書き込んだバックアップ（savedAt 付き）を返す。 */
export async function saveBlocksDraftBackup(
  projectId: string,
  draft: BlocksDraft,
  deps: ProjectStoreDeps,
  now: () => string = nowIso
): Promise<BlocksDraftBackup> {
  const backup: BlocksDraftBackup = { projectId, savedAt: now(), draft };
  await deps.write({ [BACKUP_KEY]: backup });
  return backup;
}

/**
 * 指定プロジェクトの下書きバックアップを返す。
 * 存在しない・別プロジェクトのものは null。
 */
export async function getBlocksDraftBackup(
  projectId: string,
  deps: ProjectStoreDeps
): Promise<BlocksDraftBackup | null> {
  const backup = await deps.read<BlocksDraftBackup | null>(BACKUP_KEY);
  if (!backup || backup.projectId !== projectId) {
    return null;
  }
  return backup;
}

/** 下書きバックアップを破棄する（承認・プロトコル再解析時）。 */
export async function clearBlocksDraftBackup(deps: ProjectStoreDeps): Promise<void> {
  await deps.write({ [BACKUP_KEY]: null });
}
