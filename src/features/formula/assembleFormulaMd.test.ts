import { COCHRANE_HSSS_2024_PUBMED } from '@/features/formula/skills';
import type { BlockSkeleton, FilterDesignerResult } from '@/features/formula/skills';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import {
  AssembleFormulaError,
  assembleFormulaMd,
  type AssembleInput,
  type BlockOutputs,
} from './assembleFormulaMd';

function skeleton(summary = 'concept'): BlockSkeleton {
  return {
    conceptSummary: summary,
    meshRequirements: [],
    freewordRequirements: [],
    rationale: '',
  };
}

function blockOutputs(
  overrides: Partial<BlockOutputs> = {}
): BlockOutputs {
  return {
    skeleton: skeleton(),
    mesh: [
      { descriptor: 'Diabetes Mellitus', tagSyntax: '"Diabetes Mellitus"[Mesh]', rationale: '' },
    ],
    freewords: [{ query: 'diabetes[tiab]', rationale: '' }],
    ...overrides,
  };
}

const defaultFilterResult: FilterDesignerResult = {
  filters: [],
  appendToCombination: '',
  excessFilterCandidates: [],
};

describe('assembleFormulaMd', () => {
  test('ユーザーブロックと最終結合行を含む formula を組み立てる', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1 AND #2',
      blocks: [
        blockOutputs(),
        blockOutputs({
          mesh: [{ descriptor: 'Metformin', tagSyntax: '"Metformin"[Mesh]', rationale: '' }],
          freewords: [{ query: 'metformin[tiab]', rationale: '' }],
        }),
      ],
      filterResult: defaultFilterResult,
    };
    const { formula, markdown } = assembleFormulaMd(input);
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', '3']);
    expect(formula.blocks[0]?.expression).toBe(
      '("Diabetes Mellitus"[Mesh] OR diabetes[tiab])'
    );
    expect(formula.blocks[2]?.expression).toBe('#1 AND #2');
    expect(formula.blocks[2]?.isCombination).toBe(true);
    expect(markdown).toContain('## PubMed/MEDLINE');
    expect(markdown).toContain('#3 #1 AND #2');
  });

  test('mesh / freeword が 1 候補だけなら括弧で囲まない', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1',
      blocks: [
        blockOutputs({ mesh: [], freewords: [{ query: 'aspirin[tiab]', rationale: '' }] }),
      ],
      filterResult: defaultFilterResult,
    };
    const { formula } = assembleFormulaMd(input);
    expect(formula.blocks[0]?.expression).toBe('aspirin[tiab]');
  });

  test('mesh / freeword が空なら TODO コメントでプレースホルダを残す', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1',
      blocks: [blockOutputs({ mesh: [], freewords: [] })],
      filterResult: defaultFilterResult,
    };
    const { formula } = assembleFormulaMd(input);
    expect(formula.blocks[0]?.expression).toContain('TODO');
    expect(formula.blocks[0]?.expression).toContain('concept');
  });

  test('conceptSummary 空時のフォールバックは unspecified', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1',
      blocks: [blockOutputs({ skeleton: skeleton(''), mesh: [], freewords: [] })],
      filterResult: defaultFilterResult,
    };
    const { formula } = assembleFormulaMd(input);
    expect(formula.blocks[0]?.expression).toContain('unspecified');
  });

  test('tagSyntax が空でも descriptor でフォールバック', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1',
      blocks: [
        blockOutputs({
          mesh: [{ descriptor: 'Raw Term', tagSyntax: '', rationale: '' }],
          freewords: [],
        }),
      ],
      filterResult: defaultFilterResult,
    };
    const { formula } = assembleFormulaMd(input);
    expect(formula.blocks[0]?.expression).toBe('Raw Term');
  });

  test('フィルタブロックを名前付き id で追加し、結合式に AND 追記する', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1 AND #2',
      blocks: [blockOutputs(), blockOutputs()],
      filterResult: {
        filters: [
          {
            blockId: 'RCTfilter',
            expression: COCHRANE_HSSS_2024_PUBMED,
            comment: 'Cochrane 2024',
          },
        ],
        appendToCombination: ' AND #RCTfilter',
        excessFilterCandidates: [],
      },
    };
    const { formula, markdown } = assembleFormulaMd(input);
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', 'RCTfilter', '3']);
    expect(formula.blocks[3]?.expression).toBe('#1 AND #2 AND #RCTfilter');
    expect(markdown).toContain('#RCTfilter');
    expect(markdown).toContain('#3 #1 AND #2 AND #RCTfilter');
    const reparsed = parsePubmedFormulaMd(markdown);
    expect(reparsed.blocks.map((b) => b.id)).toEqual(['1', '2', 'RCTfilter', '3']);
    expect(reparsed.combinationExpression).toBe('#1 AND #2 AND #RCTfilter');
  });

  test('baseCombinationExpression が空で append のみでも落ちない', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '',
      blocks: [blockOutputs()],
      filterResult: {
        filters: [
          { blockId: 'RCTfilter', expression: 'foo[tiab]', comment: '' },
        ],
        appendToCombination: ' AND #RCTfilter',
        excessFilterCandidates: [],
      },
    };
    const { formula } = assembleFormulaMd(input);
    expect(formula.blocks[formula.blocks.length - 1]?.expression).toBe('#RCTfilter');
  });

  test('base と append が両方空なら AssembleFormulaError', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '',
      blocks: [blockOutputs()],
      filterResult: defaultFilterResult,
    };
    expect(() => assembleFormulaMd(input)).toThrow(AssembleFormulaError);
  });

  test('block 数が 0 / 6 以上はエラー', () => {
    const filterResult = defaultFilterResult;
    expect(() =>
      assembleFormulaMd({
        baseCombinationExpression: '',
        blocks: [],
        filterResult,
      })
    ).toThrow(AssembleFormulaError);
    expect(() =>
      assembleFormulaMd({
        baseCombinationExpression: '',
        blocks: Array.from({ length: 6 }, () => blockOutputs()),
        filterResult,
      })
    ).toThrow(AssembleFormulaError);
  });

  test('生成された markdown は parsePubmedFormulaMd で丸ごとパースできる', () => {
    const input: AssembleInput = {
      baseCombinationExpression: '#1 AND #2',
      blocks: [blockOutputs(), blockOutputs()],
      filterResult: defaultFilterResult,
    };
    const { markdown } = assembleFormulaMd(input);
    const reparsed = parsePubmedFormulaMd(markdown);
    expect(reparsed.blocks.map((b) => b.id)).toEqual(['1', '2', '3']);
    expect(reparsed.blocks[2]?.isCombination).toBe(true);
  });
});
