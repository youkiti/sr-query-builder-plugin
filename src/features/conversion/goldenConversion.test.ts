import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { convertToCentral } from './toCentral';
import { convertToDialog } from './toDialog';
import { convertToClinicalTrials } from './toClinicalTrials';
import { convertToIctrp } from './toIctrp';
import {
  TREMOR_PROXIMITY_PUBMED_MD,
  TREMOR_PROXIMITY_EXPECTED_CENTRAL,
  TREMOR_PROXIMITY_EXPECTED_DIALOG,
  GAPPED_ID_PUBMED_MD,
  GAPPED_ID_EXPECTED_CENTRAL,
  GAPPED_ID_EXPECTED_DIALOG,
} from './__fixtures__/goldenFormulas';

/**
 * 実式（search_formula.md 互換フォーマット）を使ったゴールデンテスト（issue #60 3-4）。
 *
 * CENTRAL / Dialog の期待値は Python 参照実装（search-formula-developper/scripts/conversion/
 * search_converter.py）の実出力と突き合わせてあり、3-1（近接演算子）・3-2（Emtree 警告）・
 * 3-3（#N → SN の非連番対応）の回帰を検知できる。
 *
 * ClinicalTrials.gov / ICTRP は Python 側が Condition/Intervention 等へフィールド分類する
 * 別実装（clinicaltrials/converter.py・ictrp/converter.py）を持っており、本 TS 実装（MVP、
 * フィールド分類なし）とは設計が異なるため Python 出力とは突き合わせない。
 * ここでは「変換結果が決定的であること」「規約に反した壊れ方をしないこと」を
 * 固定するリグレッションテストとして扱う。
 *
 * 変換はすべて純粋な文字列処理（正規表現の置換のみ）で、fetch 等の I/O を一切行わない。
 * 実ネットワークへ出ないことを spy で明示的に確認する。
 */
describe('ゴールデンテスト: 実式フィクスチャ', () => {
  // jsdom テスト環境には fetch が存在しないため、jest.spyOn では張れない。
  // 代わりに呼ばれたら即座に分かるダミー実装を差し込み、呼び出し有無だけを検証する。
  let fetchMock: jest.Mock;
  const original = (globalThis as { fetch?: unknown }).fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    expect(fetchMock).not.toHaveBeenCalled();
    (globalThis as { fetch?: unknown }).fetch = original;
  });

  describe('近接演算子 3 パターンを含む実式（Essential Tremor）', () => {
    const formula = parsePubmedFormulaMd(TREMOR_PROXIMITY_PUBMED_MD);

    test('CENTRAL: Python 実出力と一致する', () => {
      const result = convertToCentral(formula);
      expect(result.convertedFormula).toBe(TREMOR_PROXIMITY_EXPECTED_CENTRAL);
      expect(result.warnings).toEqual([]);
    });

    test('Dialog: Python 実出力と一致する（Emtree 警告付き）', () => {
      const result = convertToDialog(formula);
      expect(result.convertedFormula).toBe(TREMOR_PROXIMITY_EXPECTED_DIALOG);
      expect(result.warnings).toEqual([
        'MeSH 記述子を Emtree 語として仮置きしています。Emtree で確認してください',
      ]);
    });

    test('ClinicalTrials.gov / ICTRP: 決定的に変換され、例外を投げない', () => {
      const ct = convertToClinicalTrials(formula);
      const ictrp = convertToIctrp(formula);
      expect(ct.convertedFormula.length).toBeGreaterThan(0);
      expect(ictrp.convertedFormula.length).toBeGreaterThan(0);
      // 近接演算子は AND 退化、MeSH/tiab/Title/ad タグは削除される（Python の
      // 専用コンバータのような Condition/Intervention 分類は行わない。MVP のまま）。
      expect(ct.convertedFormula).toContain('(deep AND brain)');
      expect(ictrp.convertedFormula).toContain('(deep AND brain)');
    });
  });

  describe('PubMed 側 ID が非連番（欠番あり）の実式', () => {
    const formula = parsePubmedFormulaMd(GAPPED_ID_PUBMED_MD);

    test('CENTRAL: Python 実出力と一致する（#N はそのまま）', () => {
      const result = convertToCentral(formula);
      expect(result.convertedFormula).toBe(GAPPED_ID_EXPECTED_CENTRAL);
    });

    test('Dialog: Python 実出力と一致する（S1..S4 に振り直され、欠番を引き継がない）', () => {
      const result = convertToDialog(formula);
      expect(result.convertedFormula).toBe(GAPPED_ID_EXPECTED_DIALOG);
      // #7 の内容は「#1 と #3」を参照しているが、#5 という欠番自体は式中に登場しない。
      // 誤って S5/S7 のような存在しない集合番号が出力に紛れ込んでいないことを確認する。
      expect(result.convertedFormula).not.toMatch(/\bS5\b/);
      expect(result.convertedFormula).not.toMatch(/\bS7\b/);
    });
  });
});
