import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToCentral } from './toCentral';

function makeFormula(blocks: Array<{ id: string; expression: string }>): PubmedFormula {
  return {
    blocks: blocks.map((b) => ({ ...b, isCombination: false })),
    combinationExpression: null,
  };
}

describe('convertToCentral', () => {
  test('"term"[Mesh] を [mh "term"] に変換する', () => {
    const result = convertToCentral(makeFormula([{ id: '1', expression: '"Diabetes Mellitus"[Mesh]' }]));
    expect(result.convertedFormula).toBe('#1 [mh "Diabetes Mellitus"]');
    expect(result.targetDb).toBe('central');
    expect(result.warnings).toEqual([]);
  });

  test('bare term[Mesh] を [mh term] に変換する', () => {
    const result = convertToCentral(makeFormula([{ id: '1', expression: 'Metformin[Mesh]' }]));
    expect(result.convertedFormula).toContain('[mh Metformin]');
  });

  test('[Mesh:NoExp] も同じく扱う', () => {
    const result = convertToCentral(makeFormula([{ id: '1', expression: '"Aspirin"[Mesh:NoExp]' }]));
    expect(result.convertedFormula).toContain('[mh "Aspirin"]');
  });

  test('"phrase"[tiab] を "phrase":ti,ab,kw に変換する', () => {
    const result = convertToCentral(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab]' }])
    );
    expect(result.convertedFormula).toContain('"heart failure":ti,ab,kw');
  });

  test('単語[tiab] を 単語:ti,ab,kw に変換する', () => {
    const result = convertToCentral(makeFormula([{ id: '1', expression: 'aspirin[tiab]' }]));
    expect(result.convertedFormula).toContain('aspirin:ti,ab,kw');
  });

  test('[Title] は :ti に変換する', () => {
    const result = convertToCentral(
      makeFormula([
        { id: '1', expression: '"heart failure"[Title]' },
        { id: '2', expression: 'metformin[Title]' },
      ])
    );
    expect(result.convertedFormula).toContain('"heart failure":ti');
    expect(result.convertedFormula).toContain('metformin:ti');
  });

  test('[ad] は削除 + 警告', () => {
    const result = convertToCentral(makeFormula([{ id: '1', expression: 'stanford[ad]' }]));
    expect(result.convertedFormula).toBe('#1 stanford');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('[ad]');
  });

  test('ブロックごとに [ad] 警告が 1 件ずつ出る', () => {
    const result = convertToCentral(
      makeFormula([
        { id: '1', expression: 'a[ad]' },
        { id: '2', expression: 'b[ad]' },
      ])
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('#1');
    expect(result.warnings[1]).toContain('#2');
  });

  test('同一ブロック内で同じ警告が重複しても 1 件に集約', () => {
    const result = convertToCentral(
      makeFormula([{ id: '1', expression: 'a[ad] OR b[ad]' }])
    );
    expect(result.warnings).toHaveLength(1);
  });

  test('HSSS 風 RCT フィルタの PubMed 固有タグ ([pt]/[sh]/[mh]) が残ると警告する', () => {
    const result = convertToCentral(
      makeFormula([
        {
          id: '1',
          expression:
            'randomized controlled trial[pt] OR drug therapy[sh] OR animals[mh]',
        },
      ])
    );
    const tagWarning = result.warnings.find((w) => w.includes('PubMed 固有タグ'));
    expect(tagWarning).toBeDefined();
    expect(tagWarning).toContain('[pt]');
    expect(tagWarning).toContain('[sh]');
    expect(tagWarning).toContain('[mh]');
    expect(tagWarning).toContain('Cochrane CENTRAL');
  });

  test('Cochrane 形 [mh "X"] のみなら残存タグ警告は出ない', () => {
    const result = convertToCentral(
      makeFormula([{ id: '1', expression: '"Diabetes Mellitus"[Mesh] OR "Aspirin"[Mesh]' }])
    );
    expect(result.warnings.some((w) => w.includes('PubMed 固有タグ'))).toBe(false);
  });

  test('複数ブロックを改行で結合する', () => {
    const result = convertToCentral(
      makeFormula([
        { id: '1', expression: '"A"[Mesh]' },
        { id: '2', expression: '#1 AND other:ti' },
      ])
    );
    expect(result.convertedFormula).toBe('#1 [mh "A"]\n#2 #1 AND other:ti');
  });
});
