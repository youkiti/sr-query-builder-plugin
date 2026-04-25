import type { IngestSummary } from '@/app/services';
import type { EfetchArticle } from '@/lib/ncbi';
import { INITIAL_STATE, type AppState } from '../store';
import { createSeedsView, detectFileMode } from './seedsView';

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

function sampleArticle(overrides: Partial<EfetchArticle> = {}): EfetchArticle {
  return {
    pmid: '111',
    title: 'Sample title',
    year: 2020,
    meshHeadings: [],
    abstract: null,
    journal: null,
    authors: [],
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    ...overrides,
  };
}

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
    articles: {},
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeFile(name: string, body: string): File {
  return {
    name,
    text: async () => body,
  } as unknown as File;
}

describe('createSeedsView', () => {
  test('プロジェクト未選択時は警告のみ', () => {
    const view = createSeedsView();
    const container = buildContainer();
    view(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('fieldset')).toBeNull();
  });

  test('PMID 入力 / ファイルアップロードの 2 セクションだけを描画する', () => {
    const view = createSeedsView();
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const legends = Array.from(container.querySelectorAll('legend')).map((l) => l.textContent);
    expect(legends).toEqual(['PMID を直接入力', 'ファイルアップロード（NBIB / RIS）']);
  });

  test('PMID 登録で onIngest が呼ばれ、サマリと書誌詳細が表示される', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        registered: 3,
        valid: 2,
        invalid: 1,
        reasons: { pmid_not_found: 1, duplicate_pmid: 0, no_pmid_resolved: 0, other: 0 },
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
        articles: {
          '111': sampleArticle({
            pmid: '111',
            title: 'Diabetes RCT',
            year: 2020,
            journal: 'The Lancet',
            authors: ['Smith J', 'Doe JA'],
            volume: '395',
            issue: '10222',
            pages: '123-130',
            abstract: 'BACKGROUND: ...\n\nMETHODS: ...',
            meshHeadings: ['Diabetes Mellitus', 'Metformin'],
            doi: '10.1016/abc',
          }),
        },
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
    // 書誌詳細カード
    const card = container.querySelector('.seeds__article')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.seeds__article-title')?.textContent).toBe('Diabetes RCT');
    expect(card.querySelector<HTMLAnchorElement>('.seeds__article-link')?.href).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/111/'
    );
    expect(card.querySelector('.seeds__article-meta')?.textContent).toContain('The Lancet');
    expect(card.querySelector('.seeds__article-meta')?.textContent).toContain('395(10222)');
    expect(card.querySelector('.seeds__article-meta')?.textContent).toContain('123-130');
    expect(card.querySelector('.seeds__article-authors')?.textContent).toContain('Smith J');
    expect(card.querySelector('.seeds__article-doi')?.textContent).toContain('10.1016/abc');
    expect(card.querySelector('.seeds__article-abstract-body')?.textContent).toContain('BACKGROUND');
    const meshItems = Array.from(card.querySelectorAll('.seeds__article-mesh-item')).map(
      (n) => n.textContent
    );
    expect(meshItems).toEqual(['Diabetes Mellitus', 'Metformin']);
  });

  test('articles に該当 PMID が無くても fallback タイトルとリンクは描画する', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        registered: 1,
        valid: 1,
        invalid: 0,
        articles: {},
      })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    const card = container.querySelector('.seeds__article')!;
    expect(card.querySelector('.seeds__article-title')?.textContent).toBe('T');
    expect(card.querySelector<HTMLAnchorElement>('.seeds__article-link')?.href).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/111/'
    );
    // optional セクションは無い
    expect(card.querySelector('.seeds__article-abstract-body')).toBeNull();
    expect(card.querySelector('.seeds__article-mesh-list')).toBeNull();
  });

  test('登録件数 0 ならサマリ内訳も書誌詳細も描画しない', async () => {
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({ registered: 0, valid: 0, invalid: 0, added: [], articles: {} })
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
    expect(container.querySelector('.seeds__article')).toBeNull();
  });

  test('無効シードはサマリには出るが書誌詳細カードには出ない', async () => {
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
        articles: {},
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
    expect(container.querySelector('.seeds__article')).toBeNull();
  });

  test('ファイルセクション: .nbib をアップロードすると mode=nbib が渡る', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const fileFieldset = Array.from(container.querySelectorAll('fieldset'))[1]!;
    const fileInput = fileFieldset.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      value: [makeFakeFile('seed.nbib', 'PMID- 111\n')],
      configurable: true,
    });
    fileFieldset.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onIngest).toHaveBeenCalledWith({ mode: 'nbib', text: 'PMID- 111\n' });
  });

  test('ファイルセクション: .ris をアップロードすると mode=ris が渡る', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const fileFieldset = Array.from(container.querySelectorAll('fieldset'))[1]!;
    const fileInput = fileFieldset.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', {
      value: [makeFakeFile('seed.ris', 'TY  - JOUR\n')],
      configurable: true,
    });
    fileFieldset.querySelector('button')!.click();
    await flushAsync();
    await flushAsync();
    expect(onIngest).toHaveBeenCalledWith({ mode: 'ris', text: 'TY  - JOUR\n' });
  });

  test('ファイル未選択でクリックしても何も起きない', async () => {
    const onIngest = jest.fn().mockResolvedValue(sampleSummary());
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const fileFieldset = Array.from(container.querySelectorAll('fieldset'))[1]!;
    fileFieldset.querySelector('button')!.click();
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

  test('著者 7 名以上は先頭 6 名 + 「ほか N 名」表記', async () => {
    const authors = Array.from({ length: 9 }, (_, i) => `Author ${i + 1}`);
    const onIngest = jest.fn().mockResolvedValue(
      sampleSummary({
        articles: {
          '111': sampleArticle({ authors }),
        },
      })
    );
    const view = createSeedsView({ onIngest });
    const container = buildContainer();
    view(container, { state: stateWithProject, navigate: jest.fn() });
    const pmidBtn = Array.from(container.querySelectorAll('fieldset'))[0]!.querySelector('button')!;
    pmidBtn.click();
    await flushAsync();
    await flushAsync();
    const text = container.querySelector('.seeds__article-authors')?.textContent ?? '';
    expect(text).toContain('Author 6');
    expect(text).toContain('ほか 3 名');
    expect(text).not.toContain('Author 7');
  });
});

describe('detectFileMode', () => {
  test('.nbib 拡張子なら nbib', async () => {
    await expect(detectFileMode(makeFakeFile('a.nbib', 'PMID- 1'))).resolves.toEqual({
      mode: 'nbib',
      text: 'PMID- 1',
    });
  });

  test('.ris 拡張子なら ris', async () => {
    await expect(detectFileMode(makeFakeFile('a.ris', 'TY  - JOUR'))).resolves.toEqual({
      mode: 'ris',
      text: 'TY  - JOUR',
    });
  });

  test('.txt + 中身が TY - 始まりなら ris', async () => {
    await expect(detectFileMode(makeFakeFile('a.txt', 'TY  - JOUR\nTI  - X'))).resolves.toEqual({
      mode: 'ris',
      text: 'TY  - JOUR\nTI  - X',
    });
  });

  test('.txt + 中身に TY - が無ければ nbib にフォールバック', async () => {
    await expect(detectFileMode(makeFakeFile('a.txt', 'PMID- 9\nTI  - Foo'))).resolves.toEqual({
      mode: 'nbib',
      text: 'PMID- 9\nTI  - Foo',
    });
  });

  test('大文字拡張子も認識する', async () => {
    await expect(detectFileMode(makeFakeFile('A.RIS', 'TY  - JOUR'))).resolves.toEqual({
      mode: 'ris',
      text: 'TY  - JOUR',
    });
  });
});
