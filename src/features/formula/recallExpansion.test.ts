import type { PubmedFormula } from '@/lib/search-formula-md';
import {
  buildBroadenedFormula,
  buildMarginQuery,
  buildUpdateProposals,
  flattenAdditions,
  matchAdditionToPaper,
  type BlockRecallAdditions,
  type IncludedPaper,
} from './recallExpansion';

function formula(): PubmedFormula {
  return {
    blocks: [
      { id: '1', expression: 'asthma[tiab]', isCombination: false },
      { id: '2', expression: 'children[tiab]', isCombination: false },
      { id: '3', expression: '#1 AND #2', isCombination: true },
    ],
    combinationExpression: '#1 AND #2',
  };
}

const additions: BlockRecallAdditions[] = [
  {
    blockId: '1',
    additions: [
      { term: '"Lung Diseases"[Mesh]', axis: 'mesh', rationale: '親概念へ拡張' },
      { term: '"wheez*"[tiab]', axis: 'freeword', rationale: '同義表現' },
    ],
  },
];

describe('buildBroadenedFormula', () => {
  test('概念ブロックを OR で広げ、結合行・他ブロック参照行は触らない', () => {
    const broadened = buildBroadenedFormula(formula(), additions);
    const b1 = broadened.blocks.find((b) => b.id === '1');
    expect(b1?.expression).toBe('(asthma[tiab]) OR "Lung Diseases"[Mesh] OR "wheez*"[tiab]');
    // 広げる対象がないブロック・結合行はそのまま
    expect(broadened.blocks.find((b) => b.id === '2')?.expression).toBe('children[tiab]');
    expect(broadened.blocks.find((b) => b.id === '3')?.expression).toBe('#1 AND #2');
    expect(broadened.combinationExpression).toBe('#1 AND #2');
  });

  test('追加語が無ければ元の式のまま', () => {
    const broadened = buildBroadenedFormula(formula(), []);
    expect(broadened.blocks.find((b) => b.id === '1')?.expression).toBe('asthma[tiab]');
  });

  test('他ブロックを参照する非結合行は広げない', () => {
    const f: PubmedFormula = {
      blocks: [
        { id: '1', expression: 'asthma[tiab]', isCombination: false },
        { id: '2', expression: '#1 AND foo[tiab]', isCombination: false },
      ],
      combinationExpression: null,
    };
    const broadened = buildBroadenedFormula(f, [
      { blockId: '2', additions: [{ term: 'bar[tiab]', axis: 'freeword', rationale: 'x' }] },
    ]);
    expect(broadened.blocks.find((b) => b.id === '2')?.expression).toBe('#1 AND foo[tiab]');
  });
});

describe('buildMarginQuery', () => {
  test('拡張式 NOT 現式の形にする', () => {
    expect(buildMarginQuery('(A) AND (B)', 'A AND B')).toBe('((A) AND (B)) NOT (A AND B)');
  });
});

describe('flattenAdditions', () => {
  test('blockId を添えて平坦化する', () => {
    const flat = flattenAdditions(additions);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toMatchObject({ blockId: '1', axis: 'mesh' });
  });
});

describe('matchAdditionToPaper', () => {
  const paper: IncludedPaper = {
    pmid: '1',
    title: 'A study of wheezing in infants',
    abstract: 'Background about respiratory illness.',
    meshHeadings: ['Lung Diseases', 'Infant'],
  };

  test('freeword はタイトル/抄録の部分一致（ワイルドカード・タグを剥がす）', () => {
    expect(matchAdditionToPaper({ term: '"wheez*"[tiab]', axis: 'freeword' }, paper)).toBe(true);
    expect(matchAdditionToPaper({ term: '"diabetes"[tiab]', axis: 'freeword' }, paper)).toBe(false);
  });

  test('mesh は MeSH 見出しと照合する', () => {
    expect(matchAdditionToPaper({ term: '"Lung Diseases"[Mesh]', axis: 'mesh' }, paper)).toBe(true);
    expect(matchAdditionToPaper({ term: '"Neoplasms"[Mesh]', axis: 'mesh' }, paper)).toBe(false);
  });

  test('2 文字未満の語は誤一致を避けて false', () => {
    expect(matchAdditionToPaper({ term: '"a"[tiab]', axis: 'freeword' }, paper)).toBe(false);
  });
});

describe('buildUpdateProposals', () => {
  const papers: IncludedPaper[] = [
    {
      pmid: '111',
      title: 'Wheezing cohort',
      abstract: '',
      meshHeadings: ['Lung Diseases'],
    },
    {
      pmid: '222',
      title: 'Unrelated topic',
      abstract: 'nothing matches here',
      meshHeadings: ['Neoplasms'],
    },
  ];

  test('回収した語だけをブロック単位に集計し、回収数降順に並べる', () => {
    const proposals = buildUpdateProposals(papers, additions);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.blockId).toBe('1');
    // mesh（Lung Diseases）と freeword（wheez）がそれぞれ 111 を回収
    expect(p.recoveredPmids).toEqual(['111']);
    expect(p.terms.map((t) => t.axis).sort()).toEqual(['freeword', 'mesh']);
    for (const term of p.terms) {
      expect(term.recoveredPmids).toEqual(['111']);
    }
  });

  test('どの論文も拾わない追加語は提案に含めない', () => {
    const proposals = buildUpdateProposals(
      [{ pmid: '999', title: 'x', abstract: 'y', meshHeadings: [] }],
      additions
    );
    expect(proposals).toEqual([]);
  });
});
