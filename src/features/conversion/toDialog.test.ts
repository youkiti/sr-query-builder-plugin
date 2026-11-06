import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToDialog } from './toDialog';
import { DIALOG_RCT_FILTER_LINES, renumberDialogRctFilter } from './dialogRctFilter';

const RCT_FILTER_FROM_S1 = DIALOG_RCT_FILTER_LINES.map((line, i) => `S${i + 1} ${line}`).join('\n');

function makeFormula(blocks: Array<{ id: string; expression: string }>): PubmedFormula {
  return {
    blocks: blocks.map((b) => ({ ...b, isCombination: false })),
    combinationExpression: null,
  };
}

describe('convertToDialog', () => {
  test('"term"[Mesh] → EMB.EXACT.EXPLODE("term") かつ SN 番号', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: '"Diabetes"[Mesh]' }]));
    expect(result.convertedFormula).toBe('S1 EMB.EXACT.EXPLODE("Diabetes")');
    expect(result.targetDb).toBe('dialog');
  });

  test('"phrase"[tiab] → (TI("phrase") OR AB("phrase"))', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab]' }])
    );
    expect(result.convertedFormula).toContain('(TI("heart failure") OR AB("heart failure"))');
  });

  test('bare term[tiab] → (TI(term) OR AB(term))', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: 'aspirin[tiab]' }]));
    expect(result.convertedFormula).toContain('(TI(aspirin) OR AB(aspirin))');
  });

  test('[Title] → TI()', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: '"X"[Title]' }]));
    expect(result.convertedFormula).toContain('TI("X")');
  });

  test('[ad] は削除 + 警告', () => {
    const result = convertToDialog(makeFormula([{ id: '1', expression: 'stanford[ad]' }]));
    expect(result.convertedFormula).toBe('S1 stanford');
    expect(result.warnings[0]).toContain('[ad]');
  });

  describe('近接演算子の変換', () => {
    test('[tiab:~N] は TI,AB(term1 N/N term2) に実変換される（警告は出さない）', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: '"A B"[tiab:~2]' }])
      );
      expect(result.convertedFormula).toBe('S1 TI,AB(A N/2 B)');
      expect(result.warnings).toEqual([]);
    });

    test('[Title:~0] は隣接（W/1）として TI(term1 W/1 term2) に変換される', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: '"A B"[Title:~0]' }])
      );
      expect(result.convertedFormula).toBe('S1 TI(A W/1 B)');
    });

    test('[ad:~N] は所属機関フィールド CS(term1 N/N term2) に変換される', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: '"hospital university"[ad:~5]' }])
      );
      expect(result.convertedFormula).toBe('S1 CS(hospital N/5 university)');
    });

    test('3 語以上は AND 結合にフォールバックする', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: '"a b c"[tiab:~2]' }])
      );
      expect(result.convertedFormula).toBe('S1 TI,AB(a AND b AND c)');
    });
  });

  test('RCT [pt] を含むブロックは Cochrane Dialog RCT フィルタ（35 行）に展開し警告なし', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: 'randomized controlled trial[pt] OR "controlled clinical trial"[pt]' }])
    );
    expect(result.convertedFormula).toBe(RCT_FILTER_FROM_S1);
    expect(result.convertedFormula.split('\n')).toHaveLength(35);
    expect(result.warnings).toHaveLength(0);
  });

  test('"Randomized Controlled Trial"[pt] のクォート付きでも代替する', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"Randomized Controlled Trial"[pt] OR random*[tiab]' }])
    );
    expect(result.convertedFormula).toBe(RCT_FILTER_FROM_S1);
    expect(result.warnings).toHaveLength(0);
  });

  test('フィルタは利用者提供の更新版（S1〜S35）と一致する', () => {
    const lines = RCT_FILTER_FROM_S1.split('\n');
    expect(lines[1]).toBe('S2 EMB.EXACT.EXPLODE("controlled clinical study")');
    expect(lines[9]).toBe(
      'S10 TI((double OR single OR doubly OR singly) NEAR/0 (blind OR blinded OR blindly)) OR AB((double OR single OR doubly OR singly) NEAR/0 (blind OR blinded OR blindly))'
    );
    expect(lines[19]).toBe(
      'S20 S1 OR S2 OR S3 OR S4 OR S5 OR S6 OR S7 OR S8 OR S9 OR S10 OR S11 OR S12 OR S13 OR S14 OR S15 OR S16 OR S17 OR S18 OR S19'
    );
    expect(lines[33]).toBe(
      'S34 S21 OR S22 OR S23 OR S24 OR S25 OR S26 OR S27 OR S28 OR S29 OR S30 OR S31 OR S32 OR S33'
    );
    expect(lines[34]).toBe('S35 S20 NOT S34');
  });

  test('前にブロックがあるとフィルタ内の参照をずらし、後続の参照はフィルタの最終行を指す', () => {
    const result = convertToDialog(
      makeFormula([
        { id: '1', expression: 'aspirin[tiab]' },
        { id: 'RCTfilter', expression: 'randomized controlled trial[pt]' },
        { id: '2', expression: '#1 AND #RCTfilter' },
      ])
    );
    const lines = result.convertedFormula.split('\n');
    expect(lines).toHaveLength(37);
    expect(lines[0]).toBe('S1 (TI(aspirin) OR AB(aspirin))');
    expect(lines.slice(1, 36)).toEqual(renumberDialogRctFilter(2).map((line, i) => `S${i + 2} ${line}`));
    expect(lines[20]).toBe(
      'S21 S2 OR S3 OR S4 OR S5 OR S6 OR S7 OR S8 OR S9 OR S10 OR S11 OR S12 OR S13 OR S14 OR S15 OR S16 OR S17 OR S18 OR S19 OR S20'
    );
    expect(lines[35]).toBe('S36 S21 NOT S35');
    expect(lines[36]).toBe('S37 S1 AND S36');
  });

  test('[pt] が RCT 以外（例: "letter"[pt]）なら残存タグ警告を出す', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"letter"[pt]' }])
    );
    const tagWarning = result.warnings.find((w) => w.includes('PubMed 固有タグ'));
    expect(tagWarning).toBeDefined();
    expect(tagWarning).toContain('[pt]');
    expect(tagWarning).toContain('Embase (Dialog)');
  });

  test('[sh]/[mh] タグが残ると警告する', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: 'drug therapy[sh] OR animals[mh]' }])
    );
    const tagWarning = result.warnings.find((w) => w.includes('PubMed 固有タグ'));
    expect(tagWarning).toBeDefined();
    expect(tagWarning).toContain('[sh]');
    expect(tagWarning).toContain('[mh]');
    expect(tagWarning).toContain('Embase (Dialog)');
  });

  test('変換可能なタグのみなら残存タグ警告は出ない', () => {
    const result = convertToDialog(
      makeFormula([{ id: '1', expression: '"heart failure"[tiab] OR "Diabetes"[Mesh]' }])
    );
    expect(result.warnings.some((w) => w.includes('PubMed 固有タグ'))).toBe(false);
  });

  test('#N 参照は SN に変換する', () => {
    const result = convertToDialog(
      makeFormula([
        { id: '1', expression: 'x' },
        { id: '2', expression: '#1 AND y' },
      ])
    );
    expect(result.convertedFormula).toContain('S2 S1 AND y');
  });

  describe('Emtree 未マッピング警告', () => {
    test('MeSH → EMB.EXACT.EXPLODE 変換が起きたら Emtree 確認を促す警告を付加する', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: '"Diabetes"[Mesh]' }])
      );
      expect(result.warnings).toContain(
        'MeSH 記述子を Emtree 語として仮置きしています。Emtree で確認してください'
      );
    });

    test('MeSH を含まなければ Emtree 警告は出ない', () => {
      const result = convertToDialog(makeFormula([{ id: '1', expression: 'aspirin[tiab]' }]));
      expect(result.warnings.some((w) => w.includes('Emtree'))).toBe(false);
    });

    test('RCT フィルタ代替では Emtree 警告を出さない（Cochrane Handbook 由来の検証済みフィルタのため）', () => {
      const result = convertToDialog(
        makeFormula([{ id: '1', expression: 'randomized controlled trial[pt]' }])
      );
      expect(result.warnings.some((w) => w.includes('Emtree'))).toBe(false);
    });
  });

  describe('#N → SN の採番（line_mapping）', () => {
    test('PubMed 側の ID が連番でなくても、出現順に S1, S2, ... を振り直す', () => {
      const result = convertToDialog(
        makeFormula([
          { id: '1', expression: 'a[tiab]' },
          { id: '3', expression: 'b[tiab]' },
          { id: '5', expression: '#1 AND #3' },
        ])
      );
      const lines = result.convertedFormula.split('\n');
      expect(lines[0]).toBe('S1 (TI(a) OR AB(a))');
      expect(lines[1]).toBe('S2 (TI(b) OR AB(b))');
      expect(lines[2]).toBe('S3 S1 AND S2');
    });

    test('ID が別の ID の接頭辞でも誤って部分一致しない（#1 と #12）', () => {
      const result = convertToDialog(
        makeFormula([
          { id: '1', expression: 'a[tiab]' },
          { id: '12', expression: 'b[tiab]' },
          { id: '13', expression: '#1 AND #12' },
        ])
      );
      const lines = result.convertedFormula.split('\n');
      expect(lines[2]).toBe('S3 S1 AND S2');
    });
  });
});
