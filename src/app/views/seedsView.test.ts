import type { IngestSummary } from '@/app/services';
import { INITIAL_STATE, type AppState } from '../store';
import { createSeedsView } from './seedsView';

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

function sampleSummary(overrides: Partial<IngestSummary> = {}): IngestSummary {
  return {
    registered: 1,
    valid: 1,
    invalid: 0,
    reasons: { pmid_not_found: 0, duplicate_pmid: 0, no_pmid_resolved: 0, other: 0 },
    added: [
      {
        pmid: '111',
        title: 'T',
        year: 2020,
        source: 'initial',
        ingestFormat: 'pmid_direct',
        originalDb: null,
        isValid: true,
        exclusionReason: null,
        originalPayloadRef: null,
        userDecision: null,
        decidedAt: null,
        decidedBy: null,
        note: null,
      },
    ],
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSeedsView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createSeedsView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('fieldset')).toBeNull();
  });

  test('3 つのセクション（PMID / NBIB / RIS）を描画する', () => {
    const view = createSeedsView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const legends = Array.from(container.querySelectorAll('legend')).map((l) => l.textContent);
    expect(legends).toEqual(['PMID を直接入力', 'NBIB アップロード', 'RIS アップロード']);
  });

  test('PMID 登録で onIngest が呼ばれ、サマリが表示される', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        registered: 3,
        valid: 2,
        invalid: 1,
        reasons: { pmid_not_found: 1, duplicate_pmid: 0, no_pmid_resolved: 0, other: 0 },
      })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.seeds__pmid-input')!;
    textarea.value = '111\n222, 333';
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    expect(onIngest).toHaveBeenCalledWith({
      mode: 'pmid_direct',
      pmids: ['111', '222', '333'],
    });
    expect(container.querySelector('.seeds__status')?.textContent).toContain('3 件登録');
    expect(container.querySelector('.seeds__reasons')?.textContent).toContain('PMID 不在: 1');
    expect(container.querySelectorAll('.seeds__added li')).toHaveLength(1);
  });

  test('登録件数 0 ならサマリ内訳は描画しない', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({ registered: 0, valid: 0, invalid: 0, added: [] })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('.seeds__pmid-input')!;
    textarea.value = '';
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.seeds__reasons')).toBeNull();
    expect(container.querySelector('.seeds__added')).toBeNull();
  });

  test('pmid=null かつ title=null / exclusionReason=null でも表示が壊れない', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        registered: 1,
        valid: 0,
        invalid: 1,
        reasons: { pmid_not_found: 0, duplicate_pmid: 0, no_pmid_resolved: 1, other: 0 },
        added: [
          {
            pmid: null,
            title: null,
            year: null,
            source: 'initial',
            ingestFormat: 'ris_no_pmid',
            originalDb: null,
            isValid: false,
            exclusionReason: null,
            originalPayloadRef: null,
            userDecision: null,
            decidedAt: null,
            decidedBy: null,
            note: null,
          },
        ],
      })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    const li = container.querySelector('.seeds__added li')?.textContent ?? '';
    expect(li).toContain('(PMID 無し)');
    expect(li).toContain('無効');
  });

  test('各内訳を含むサマリも描画される', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        registered: 4,
        valid: 0,
        invalid: 4,
        reasons: { pmid_not_found: 1, duplicate_pmid: 1, no_pmid_resolved: 1, other: 1 },
        added: [
          {
            pmid: null,
            title: 'Non PubMed',
            year: null,
            source: 'initial',
            ingestFormat: 'ris_no_pmid',
            originalDb: 'Embase',
            isValid: false,
            exclusionReason: 'no_pmid_resolved',
            originalPayloadRef: null,
            userDecision: null,
            decidedAt: null,
            decidedBy: null,
            note: null,
          },
        ],
      })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    const text = container.querySelector('.seeds__reasons')?.textContent ?? '';
    expect(text).toContain('重複: 1');
    expect(text).toContain('PMID 解決不能: 1');
    expect(text).toContain('その他: 1');
    expect(container.querySelector('.seeds__added li')?.textContent).toContain('Non PubMed');
  });

  test('NBIB セクションでファイルをアップロードすると onIngest に text が渡る', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const nbibFieldset = Array.from(container.querySelectorAll('fieldset'))[1]!;
    const fileInput = nbibFieldset.querySelector('input[type=file]') as HTMLInputElement;
    const fakeFile = {
      name: 'seed.nbib',
      text: async () => 'PMID- 111\n',
    } as unknown as File;
    Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
    nbibFieldset.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onIngest).toHaveBeenCalledWith({ mode: 'nbib', text: 'PMID- 111\n' });
  });

  test('RIS セクションでファイルをアップロードすると onIngest に text が渡る', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const risFieldset = Array.from(container.querySelectorAll('fieldset'))[2]!;
    const fileInput = risFieldset.querySelector('input[type=file]') as HTMLInputElement;
    const fakeFile = {
      name: 'seed.ris',
      text: async () => 'TY  - JOUR\n',
    } as unknown as File;
    Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
    risFieldset.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onIngest).toHaveBeenCalledWith({ mode: 'ris', text: 'TY  - JOUR\n' });
  });

  test('ファイル未選択のファイルフォームはクリックしても何もしない', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const nbibFieldset = Array.from(container.querySelectorAll('fieldset'))[1]!;
    nbibFieldset.querySelector('button')!.click();
    await flushAsync();
    expect(onIngest).not.toHaveBeenCalled();
  });

  test('onIngest が reject したらエラーボックスに表示', async () => {
    const onIngest = jest.fn().mockRejectedValue(new Error('boom'));
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    (container.querySelector('.seeds__pmid-input') as HTMLTextAreaElement).value = '111';
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.seeds__error')?.textContent).toBe('boom');
    expect(container.querySelector('.seeds__status')?.textContent).toBe('');
  });

  test('Error 以外の例外も String 化', async () => {
    const onIngest = jest.fn().mockRejectedValue('rare');
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    (container.querySelector('.seeds__pmid-input') as HTMLTextAreaElement).value = '111';
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    expect(container.querySelector('.seeds__error')?.textContent).toBe('rare');
  });

  test('onIngest 未指定でもクリックで例外にならない', () => {
    const view = createSeedsView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    expect(() => pmidBtn.click()).not.toThrow();
  });
});
