import type { ProjectStoreDeps } from '@/features/project';
import type { BlocksDraft } from '../store';
import {
  clearBlocksDraftBackup,
  getBlocksDraftBackup,
  saveBlocksDraftBackup,
} from './blocksDraftBackupService';

function makeDeps(): { deps: ProjectStoreDeps; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    deps: {
      read: async <T>(key: string) => data[key] as T | undefined,
      write: async (items) => {
        Object.assign(data, items);
      },
    },
  };
}

function makeDraft(label = 'P'): BlocksDraft {
  return {
    blocks: [{ blockLabel: label, description: 'desc', aiGenerated: false, note: '' }],
    combinationExpression: '#1',
  };
}

describe('blocksDraftBackupService', () => {
  test('save → get で同じ下書きが返り、savedAt が付与される', async () => {
    const { deps } = makeDeps();
    const saved = await saveBlocksDraftBackup('proj-1', makeDraft(), deps, () => '2026-07-02T00:00:00Z');
    expect(saved.savedAt).toBe('2026-07-02T00:00:00Z');

    const backup = await getBlocksDraftBackup('proj-1', deps);
    expect(backup).not.toBeNull();
    expect(backup?.draft.blocks[0]?.blockLabel).toBe('P');
    expect(backup?.savedAt).toBe('2026-07-02T00:00:00Z');
  });

  test('別プロジェクトのバックアップは null を返す', async () => {
    const { deps } = makeDeps();
    await saveBlocksDraftBackup('proj-1', makeDraft(), deps);
    await expect(getBlocksDraftBackup('proj-2', deps)).resolves.toBeNull();
  });

  test('バックアップが無ければ null', async () => {
    const { deps } = makeDeps();
    await expect(getBlocksDraftBackup('proj-1', deps)).resolves.toBeNull();
  });

  test('clear で破棄される', async () => {
    const { deps } = makeDeps();
    await saveBlocksDraftBackup('proj-1', makeDraft(), deps);
    await clearBlocksDraftBackup(deps);
    await expect(getBlocksDraftBackup('proj-1', deps)).resolves.toBeNull();
  });

  test('上書き保存は最後の下書きが正になる', async () => {
    const { deps } = makeDeps();
    await saveBlocksDraftBackup('proj-1', makeDraft('old'), deps);
    await saveBlocksDraftBackup('proj-1', makeDraft('new'), deps);
    const backup = await getBlocksDraftBackup('proj-1', deps);
    expect(backup?.draft.blocks[0]?.blockLabel).toBe('new');
  });
});
