import { INITIAL_STATE, type AppState } from '../store';
import { setUiLanguage } from '@/lib/i18n';
import { renderDoneView } from './doneView';

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

const SAMPLE_MD = [
  '## PubMed/MEDLINE',
  '',
  '```',
  '#1 asthma[tiab]',
  '#2 children[tiab]',
  '#3 #1 AND #2',
  '```',
  '',
].join('\n');

describe('renderDoneView', () => {
  test('英語で見出し・主なリンク・案内を表示する', () => {
    try {
      setUiLanguage('en');
      const container = buildContainer();
      renderDoneView(container, {
        state: { ...stateWithProject, currentFormulaMarkdown: SAMPLE_MD },
        navigate: jest.fn(),
      });
      expect(container.querySelector('h2')?.textContent).toBe('Done');
      expect(Array.from(container.querySelectorAll('.done__links a')).map((node) => node.textContent)).toEqual([
        'Open Cochrane CENTRAL', 'Open Embase (Dialog)', 'Open ClinicalTrials.gov', 'Open ICTRP',
      ]);
      expect(container.querySelector('.done__lead')?.textContent).toContain('Your search formula is ready.');
      expect(container.querySelector('.done__pubmed-link span')?.textContent).toBe('Open directly in PubMed: ');
      expect(container.querySelector('.done__link-note')?.textContent).toContain('Paste the converted search formula');
    } finally {
      setUiLanguage('ja');
    }
  });

  test('プロジェクト未選択時は警告のみ', () => {
    const container = buildContainer();
    renderDoneView(container, { state: INITIAL_STATE, navigate: jest.fn() });
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('プロジェクト');
    expect(container.querySelector('.done__links')).toBeNull();
  });

  test('検索式未生成時は /draft への誘導を出す', () => {
    const container = buildContainer();
    renderDoneView(
      container,
      { state: stateWithProject, navigate: jest.fn() }
    );
    expect(container.querySelector('.view__placeholder')?.textContent).toContain('/draft');
    expect(container.querySelector('.done__links')).toBeNull();
  });

  test('PubMed リンクと外部 DB リンク一覧を描画する', () => {
    const container = buildContainer();
    renderDoneView(container, {
      state: { ...stateWithProject, currentFormulaMarkdown: SAMPLE_MD },
      navigate: jest.fn(),
    });
    const pubmedLink = container.querySelector<HTMLAnchorElement>('.done__pubmed-link a');
    expect(pubmedLink).not.toBeNull();
    expect(pubmedLink!.href).toContain('pubmed.ncbi.nlm.nih.gov');
    expect(pubmedLink!.href).toContain('asthma');
    expect(pubmedLink!.target).toBe('_blank');
    expect(pubmedLink!.rel).toBe('noopener noreferrer');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('.done__links a'));
    expect(links).toHaveLength(4);
    expect(links.map((a) => a.textContent)).toEqual([
      'Cochrane CENTRAL で開く',
      'Embase (Dialog) で開く',
      'ClinicalTrials.gov で開く',
      'ICTRP で開く',
    ]);
    for (const a of links) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
    expect(container.querySelector('.done__note')?.textContent).toContain('NBIB');
  });

  test('パース失敗時は PubMed リンクを出さない', () => {
    const container = buildContainer();
    renderDoneView(container, {
      state: { ...stateWithProject, currentFormulaMarkdown: 'no section here' },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.done__pubmed-link')).toBeNull();
    // 外部リンクは出る
    expect(container.querySelectorAll('.done__links a')).toHaveLength(4);
  });

  test('空のコードブロックなら PubMed リンクを出さない', () => {
    const container = buildContainer();
    renderDoneView(container, {
      state: {
        ...stateWithProject,
        currentFormulaMarkdown: '## PubMed/MEDLINE\n\n```\n\n```\n',
      },
      navigate: jest.fn(),
    });
    expect(container.querySelector('.done__pubmed-link')).toBeNull();
  });
});
