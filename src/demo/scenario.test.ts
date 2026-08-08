import { DEMO_CORPUS, SEED_PMIDS, RECOMMENDED_BOUNDARY_INCLUDE_PMID } from './corpus';
import { evaluateQuery } from './queryEngine';
import {
  BLOCK_DEFS,
  buildBlockExpressions,
  buildFormulaV1,
  buildFormulaV2,
  buildValidationSummary,
  computeScenarioFacts,
} from './scenario';

/**
 * video/REQUIREMENTS.md §6-2 の不変条件を固定する回帰テスト。
 *
 * ここで確認していることは「章ごとに見せる数字が、コーパスを実際に評価した結果と
 * 一致し続けること」。将来コーパスや LLM フィクスチャの文言を直したときに、
 * 数字だけが静かにズレる事故を防ぐのが目的（撮影後に気づくと 16 分の撮り直しになる）。
 */

describe('DEMO_CORPUS', () => {
  it('12 本の架空論文を持ち、PMID は実在の帯 (90000001〜) の外にある', () => {
    expect(DEMO_CORPUS).toHaveLength(12);
    for (const paper of DEMO_CORPUS) {
      expect(Number(paper.pmid)).toBeGreaterThanOrEqual(90000001);
    }
  });

  it('PMID が重複しない', () => {
    const pmids = DEMO_CORPUS.map((p) => p.pmid);
    expect(new Set(pmids).size).toBe(pmids.length);
  });
});

describe('シード / 境界事例の PMID 帯', () => {
  it('シード 5 本はすべてコーパスに実在する', () => {
    for (const pmid of SEED_PMIDS) {
      expect(DEMO_CORPUS.some((p) => p.pmid === pmid)).toBe(true);
    }
  });

  it('推奨 include PMID はシード集合の外にある', () => {
    expect(SEED_PMIDS as readonly string[]).not.toContain(RECOMMENDED_BOUNDARY_INCLUDE_PMID);
  });
});

describe('ブロック単体のヒット数（#1〜#3, 07 章の line_hits）', () => {
  it('esearch のヒット数はコーパスを評価した集合の要素数と一致する', () => {
    const facts = computeScenarioFacts();
    const expressions = buildBlockExpressions();

    // 「ハードコードした数字を別に持たない」ことを検証するため、期待値そのものも
    // ここで evaluateQuery を直接呼んで再計算し、facts の値と突き合わせる。
    for (const def of BLOCK_DEFS) {
      const recomputed = evaluateQuery(expressions[def.key], DEMO_CORPUS).length;
      expect(facts.blockHits[def.key]).toBe(recomputed);
    }
  });

  it('#1(ARDS) は 8 件、#2(ECMO) は 6 件、#3(RCT フィルタ) は 10 件にヒットする', () => {
    const facts = computeScenarioFacts();
    expect(facts.blockHits.ards).toBe(8);
    expect(facts.blockHits.ecmo).toBe(6);
    expect(facts.blockHits.rct).toBe(10);
  });
});

describe('v1 最終式のシード捕捉率（08 章: 80%）', () => {
  it('5 本中 4 本を捕捉し、90000005 だけを取りこぼす', () => {
    const facts = computeScenarioFacts();
    expect(facts.finalV1Pmids).toHaveLength(4);
    expect(facts.capturedV1.sort()).toEqual(['90000001', '90000002', '90000003', '90000004']);
    expect(facts.missedV1).toEqual(['90000005']);
  });

  it('捕捉率を SEED_PMIDS から計算すると 0.8 になる', () => {
    const facts = computeScenarioFacts();
    const captureRate = facts.capturedV1.length / SEED_PMIDS.length;
    expect(captureRate).toBeCloseTo(0.8, 10);
  });
});

describe('境界事例（09 章: margin 上の候補 3 本）', () => {
  it('margin から既存シードを除くとちょうど 3 本になり、推奨 include PMID を含む', () => {
    const facts = computeScenarioFacts();
    expect(facts.boundaryCandidatePmids.sort()).toEqual(['90000006', '90000007', '90000008']);
    expect(facts.boundaryCandidatePmids).toContain(RECOMMENDED_BOUNDARY_INCLUDE_PMID);
  });

  it('候補が空にならない（PR2 受け入れ基準）', () => {
    const facts = computeScenarioFacts();
    expect(facts.boundaryCandidatePmids.length).toBeGreaterThan(0);
  });
});

describe('v2 最終式のシード捕捉率（10 章: 100%）', () => {
  it('ブロック #2 に MeSH タグを追加すると、90000005 と推奨 include PMID の両方を捕捉する', () => {
    const facts = computeScenarioFacts();
    expect(facts.finalV2Pmids).toEqual(expect.arrayContaining([...SEED_PMIDS]));
    expect(facts.finalV2Pmids).toContain(RECOMMENDED_BOUNDARY_INCLUDE_PMID);
  });

  it('90000005 を含む拡張後シード集合（初期 5 本 + 推奨 include 1 本）に対する捕捉率が 100% になる', () => {
    const facts = computeScenarioFacts();
    const expandedSeedSet = [...SEED_PMIDS, RECOMMENDED_BOUNDARY_INCLUDE_PMID];
    const finalV2Set = new Set(facts.finalV2Pmids);
    const captured = expandedSeedSet.filter((p) => finalV2Set.has(p));
    expect(captured.length / expandedSeedSet.length).toBe(1);
  });
});

describe('buildFormulaV1 / buildFormulaV2 は本番の assembleFormulaMd 経由で組み立てる', () => {
  it('v1 は #1〜#3 と最終行 #4 の 4 ブロックを持つ', () => {
    const { formula } = buildFormulaV1();
    expect(formula.blocks.map((b) => b.id)).toEqual(['1', '2', '3', '4']);
    expect(formula.blocks[3]?.isCombination).toBe(true);
  });

  it('v2 のブロック #2 には ECMO の MeSH タグが含まれる', () => {
    const { formula } = buildFormulaV2();
    const block2 = formula.blocks.find((b) => b.id === '2');
    expect(block2?.expression).toContain('"Extracorporeal Membrane Oxygenation"[Mesh]');
  });

  it('v1 のブロック #2 には MeSH タグが含まれない（08 章で追加を提案する前提）', () => {
    const { formula } = buildFormulaV1();
    const block2 = formula.blocks.find((b) => b.id === '2');
    expect(block2?.expression).not.toContain('[Mesh]');
  });
});

describe('buildValidationSummary（章ごとの検証結果パネルの事前投入用）', () => {
  it('v1 × 初期シード 5 本では捕捉率 80% になる（08 章）', () => {
    const summary = buildValidationSummary(buildFormulaV1().markdown, SEED_PMIDS);
    expect(summary.finalQuery.captureRate).toBeCloseTo(0.8, 10);
    expect(summary.finalQuery.missedPmids).toEqual(['90000005']);
    expect(summary.lineHits.map((l) => l.hitCount)).toEqual([8, 6, 10, 4]);
    expect(summary.meshFrequency.length).toBeGreaterThan(0);
    expect(summary.meshHierarchy.length).toBeGreaterThan(0);
  });

  it('v1 × 拡張後シード 6 本（境界事例 include 後）では捕捉率が下がる（09 章のラウンド完了）', () => {
    const summary = buildValidationSummary(buildFormulaV1().markdown, [
      ...SEED_PMIDS,
      RECOMMENDED_BOUNDARY_INCLUDE_PMID,
    ]);
    expect(summary.finalQuery.captureRate).toBeCloseTo(4 / 6, 10);
    expect(summary.finalQuery.missedPmids.sort()).toEqual(['90000005', '90000006']);
  });

  it('v2 × 拡張後シード 6 本では捕捉率 100% になる（10 章）', () => {
    const summary = buildValidationSummary(buildFormulaV2().markdown, [
      ...SEED_PMIDS,
      RECOMMENDED_BOUNDARY_INCLUDE_PMID,
    ]);
    expect(summary.finalQuery.captureRate).toBe(1);
    expect(summary.finalQuery.missedPmids).toEqual([]);
  });
});
