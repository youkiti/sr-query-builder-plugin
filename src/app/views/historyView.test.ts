import type { FormulaVersion } from '@/domain/formulaVersion';
import { INITIAL_STATE, type AppState } from '../store';
import { createHistoryView } from './historyView';

function buildContainer(): HTMLElement {
  const doc = document.implementation.createHTMLDocument('test');
  const div = doc.createElement('div');
  doc.body.appendChild(div);
  return div;
}

const stateWithProject: AppState = {
  ...INITIAL_STATE,
  project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'T' },
};

function buildVersion(overrides: Partial<FormulaVersion> = {}): FormulaVersion {
  return {
    versionId: 'v1',
    parentVersionId: null,
    protocolVersion: 1,
    protocolSnapshotRef: 'snap',
    formulaMd: '## PubMed/MEDLINE\n\n```\n#1 asthma[tiab]\n```\n',
    createdBy: 'ai_draft',
    createdAt: '2026-04-19T00:00:00.000Z',
    note: null,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createHistoryView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createHistoryView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.history__list')).toBeNull();
  });

  test('onList 未指定なら status を空にして終了', () => {
    const view = createHistoryView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    expect(container.querySelector('.history__status')?.textContent).toBe('');
    expect(container.querySelectorAll('.history__item')).toHaveLength(0);
  });

  test('バージョンが 0 件ならその旨を表示', async () => {
    const onList = jest.fn().mockResolvedValue([]);
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    expect(container.querySelector('.history__status')?.textContent).toContain('まだバージョン');
    expect(container.querySelectorAll('.history__item')).toHaveLength(0);
  });

  test('複数バージョンを一覧表示し、active バッジ・parent・note もレンダリングする', async () => {
    const onList = jest.fn().mockResolvedValue([
      buildVersion({ versionId: 'v3', parentVersionId: 'v2', note: 'MeSH 追加' }),
      buildVersion({ versionId: 'v2', parentVersionId: 'v1' }),
      buildVersion({ versionId: 'v1' }),
    ]);
    const onLoad = jest.fn();
    const view = createHistoryView({ onList, onLoad });
    const container = buildContainer();
    view(container, {
      state: { ...stateWithProject, currentFormulaVersionId: 'v2' },
      navigate: jest.fn(),
    });
    await flushAsync();
    const items = Array.from(container.querySelectorAll('.history__item'));
    expect(items).toHaveLength(3);
    expect(container.querySelector('.history__status')?.textContent).toContain('3 件');
    // active バッジは v2 のみ
    const badges = container.querySelectorAll('.history__badge');
    expect(badges).toHaveLength(1);
    expect(items[1]?.querySelector('.history__badge')?.textContent).toBe('読み込み中');
    // note あり・なし
    expect(items[0]?.querySelector('.history__note')?.textContent).toBe('MeSH 追加');
    expect(items[2]?.querySelector('.history__note')).toBeNull();
    // parent 表示
    expect(items[0]?.querySelector('.history__meta')?.textContent).toContain('← v2');
    expect(items[2]?.querySelector('.history__meta')?.textContent).not.toContain('←');
    // 読み込みボタンで onLoad 呼び出し
    const firstLoadBtn = items[0]!.querySelector<HTMLButtonElement>('.history__load')!;
    firstLoadBtn.click();
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'v3' }));
  });

  test('プレビューは 10 行までで超過なら … を付ける', async () => {
    const longMd = Array.from({ length: 20 }, (_, i) => `#${i + 1} x${i}`).join('\n');
    const onList = jest.fn().mockResolvedValue([buildVersion({ formulaMd: longMd })]);
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    const preview = container.querySelector('.history__preview')?.textContent ?? '';
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.split('\n')).toHaveLength(11); // 10 行 + 省略記号の行
  });

  test('10 行以下なら省略記号は付かない', async () => {
    const onList = jest.fn().mockResolvedValue([buildVersion({ formulaMd: '#1 x\n#2 y' })]);
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    const preview = container.querySelector('.history__preview')?.textContent ?? '';
    expect(preview.endsWith('…')).toBe(false);
    expect(preview).toBe('#1 x\n#2 y');
  });

  test('note が空文字ならレンダリングしない', async () => {
    const onList = jest.fn().mockResolvedValue([buildVersion({ note: '' })]);
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    expect(container.querySelector('.history__note')).toBeNull();
  });

  test('onList が reject したらエラー表示', async () => {
    const onList = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    expect(container.querySelector('.history__error')?.textContent).toBe('boom');
    expect(container.querySelector('.history__status')?.textContent).toBe('');
  });

  test('Error 以外の例外も String 化される', async () => {
    const onList = jest.fn().mockRejectedValue('rare');
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    expect(container.querySelector('.history__error')?.textContent).toBe('rare');
  });

  test('onLoad 未指定でもクリックで例外にならない', async () => {
    const onList = jest.fn().mockResolvedValue([buildVersion()]);
    const view = createHistoryView({ onList });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    await flushAsync();
    const btn = container.querySelector<HTMLButtonElement>('.history__load')!;
    expect(() => btn.click()).not.toThrow();
  });
});
