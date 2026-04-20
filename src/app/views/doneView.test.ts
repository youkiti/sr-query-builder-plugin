import { INITIAL_STATE, type AppState } from '../store';
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
    expect(links).toHaveLength(3);
    expect(links.map((a) => a.textContent)).toEqual([
      'Cochrane CENTRAL で開く',
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
    expect(container.querySelectorAll('.done__links a')).toHaveLength(3);
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
