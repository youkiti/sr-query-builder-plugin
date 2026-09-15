import { GeminiProvider } from '@/lib/llm';
import type { LLMProvider } from '@/lib/llm';
import { detectGeminiTier } from '@/lib/llm/geminiTierDetector';
import {
  designBlock,
  designFreewords,
  expandQueryForRecall,
  extractProtocol,
  improveBlockExpression,
  interpretResult,
  pickBoundaryCases,
  suggestMesh,
} from '@/features/formula/skills';
import { handleGeminiGenerateContent } from './llmFixtures';
import { optimizeQuery, type OptimizeQueryInput } from '@/features/formula/skills/optimizeQuery';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import { esearch, sharedEutilsRateLimiters } from '@/lib/ncbi';
import { expandFormula } from '@/features/validation';
import { runOptimizeQuery, startApp } from '@/app/bootstrap';
import { adoptQueryOptimization } from '@/app/services/queryOptimizationAdoptionService';
import type { ChromeRuntimeDeps } from '@/app/services/factories';
import { demoFetch } from './fetchMock';
import { applyDemoSeed } from './seeds';
import {
  BLOCK_DEFS,
  ECMO_MESH_ADDITION,
  RESEARCH_QUESTION,
  buildBlockExpressions,
  buildFormulaV1,
  SEED_PMIDS,
  getBlockDef,
} from './scenario';

/**
 * llmFixtures.ts を「本番の skill 関数から呼んだときに正しく応答するか」で検証する。
 * `GeminiProvider` はそのまま使い、fetch だけ `handleGeminiGenerateContent` に差し替える
 * ことで、実際のプロンプト整形〜構造化出力パースまでの経路をエンドツーエンドで確認する。
 */
function makeProvider(): LLMProvider {
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) =>
    handleGeminiGenerateContent(init ?? {})) as unknown as typeof fetch;
  return new GeminiProvider({ apiKey: 'demo-api-key', fetch: fetchImpl });
}

describe('extract-protocol フィクスチャ', () => {
  it('ブロック #1〜#3（ARDS/ECMO/RCT フィルタ）を返す', async () => {
    const draft = await extractProtocol('何か入力されたプロトコル本文', makeProvider());
    expect(draft.frameworkType).toBe('pico');
    expect(draft.researchQuestion).toBe(RESEARCH_QUESTION);
    expect(draft.blocks.map((b) => b.blockLabel)).toEqual(['ARDS', 'ECMO', 'RCT フィルタ']);
    expect(draft.combinationExpression).toBe('#1 AND #2 AND #3');
  });
});

describe('block-designer フィクスチャ', () => {
  it.each(BLOCK_DEFS.map((d) => [d.blockLabel, d.key] as const))(
    'ブロック %s を渡すと対応する conceptSummary を返す',
    async (blockLabel, key) => {
      const def = getBlockDef(key);
      const skeleton = await designBlock(
        {
          blockLabel,
          description: def.blockDescription,
          researchQuestion: RESEARCH_QUESTION,
          seedTitles: [],
        },
        makeProvider()
      );
      expect(skeleton.conceptSummary).toBe(def.conceptSummary);
    }
  );

  it('対応しないブロックは目立つエラーを投げる（空を返さない）', async () => {
    await expect(
      designBlock(
        { blockLabel: 'Unknown', description: '謎の概念', researchQuestion: RESEARCH_QUESTION },
        makeProvider()
      )
    ).rejects.toThrow();
  });
});

describe('mesh-suggester / freeword-designer フィクスチャ', () => {
  it('ARDS ブロックは MeSH 提案 1 件・フリーワード 2 件を返す', async () => {
    const ards = getBlockDef('ards');
    const provider = makeProvider();
    const mesh = await suggestMesh(
      { conceptSummary: ards.conceptSummary, meshRequirements: [...ards.meshRequirements], seedMesh: { seedCount: 0, concepts: [], checkTags: [] } },
      provider
    );
    expect(mesh).toEqual(ards.meshV1);
    const freewords = await designFreewords(
      {
        conceptSummary: ards.conceptSummary,
        freewordRequirements: [...ards.freewordRequirements],
        meshSuggestions: mesh.map((m) => ({ descriptor: m.descriptor })),
      },
      provider
    );
    expect(freewords).toEqual(ards.freewords);
  });

  it('ECMO ブロックは v1 で MeSH 提案が空になる（08 章で後から追加提案する前提）', async () => {
    const ecmo = getBlockDef('ecmo');
    const mesh = await suggestMesh(
      { conceptSummary: ecmo.conceptSummary, meshRequirements: [], seedMesh: { seedCount: 0, concepts: [], checkTags: [] } },
      makeProvider()
    );
    expect(mesh).toEqual([]);
  });

  /*
   * 回帰: seed 情報を空で渡すとこの不具合は再現しない。
   * mesh-suggester / freeword-designer のプロンプトは末尾に seed の MeSH 一覧や
   * ti/ab コーパスを丸ごと含むため、ブロック判定をテキスト全体で行うと
   * seed 側の語（デモの seed は ARDS/ECMO の論文なので "ARDS" を含む）を拾って
   * BLOCK_DEFS 先頭の ards のフィクスチャが全ブロックに返っていた。
   * 実害は第 7 章の生成結果で、#2 ECMO と #3 RCT フィルタが両方とも
   * ARDS のフリーワードになっていた。必ず seed 込みで検証すること。
   */
  describe('seed 側の語に引きずられない（ブロック取り違えの回帰）', () => {
    // 他ブロックのキーワード（ARDS）を必ず含む、実際に近い seed コーパス
    const SEED_SAMPLES = [
      {
        title: 'ECMO for severe ARDS: a randomized controlled trial',
        abstract:
          'Patients with acute respiratory distress syndrome were randomized to extracorporeal membrane oxygenation or conventional ventilation.',
      },
      {
        title: 'Venovenous extracorporeal membrane oxygenation in ARDS',
        abstract: 'A randomised multicentre trial in adults with acute respiratory distress syndrome.',
      },
    ];
    const SEED_MESH = {
      seedCount: 2,
      concepts: [
        { descriptor: 'Respiratory Distress Syndrome', count: 2, majorCount: 2, qualifiers: [] },
        { descriptor: 'Extracorporeal Membrane Oxygenation', count: 2, majorCount: 2, qualifiers: [] },
      ],
      checkTags: [],
    };

    it.each(['ards', 'ecmo', 'rct'] as const)(
      '%s ブロックは seed に ARDS が出てきても自分のフリーワードを返す',
      async (key) => {
        const def = getBlockDef(key);
        const freewords = await designFreewords(
          {
            conceptSummary: def.conceptSummary,
            freewordRequirements: [...def.freewordRequirements],
            meshSuggestions: def.meshV1.map((m) => ({ descriptor: m.descriptor })),
            seedSamples: SEED_SAMPLES,
          },
          makeProvider()
        );
        expect(freewords).toEqual(def.freewords);
      }
    );

    it.each(['ards', 'ecmo', 'rct'] as const)(
      '%s ブロックは seed の MeSH に引きずられず自分の MeSH 提案を返す',
      async (key) => {
        const def = getBlockDef(key);
        const mesh = await suggestMesh(
          {
            conceptSummary: def.conceptSummary,
            meshRequirements: [...def.meshRequirements],
            seedMesh: SEED_MESH,
          },
          makeProvider()
        );
        expect(mesh).toEqual(def.meshV1);
      }
    );
  });
});

describe('expand-query-for-recall フィクスチャ（09 章の拡張語）', () => {
  it('ARDS/ECMO ブロックには拡張語を返し、RCT フィルタは広げない', async () => {
    const v1 = buildBlockExpressions();
    const additions = await expandQueryForRecall(
      {
        researchQuestion: RESEARCH_QUESTION,
        blocks: [
          { id: '1', expression: v1.ards },
          { id: '2', expression: v1.ecmo },
          { id: '3', expression: v1.rct },
        ],
      },
      makeProvider()
    );
    // filter ブロック（additions が空）は expandQueryForRecall 自身の仕様で出力から除外される
    expect(additions.map((a) => a.blockId).sort()).toEqual(['1', '2']);
    const block2 = additions.find((a) => a.blockId === '2');
    expect(block2?.additions.some((t) => t.term.includes('Extracorporeal Membrane Oxygenation'))).toBe(
      true
    );
  });
});

describe('pick-boundary-cases フィクスチャ（09 章の境界事例、空にならない）', () => {
  it('候補として渡した PMID の中から選ぶ', async () => {
    const candidates = [
      { pmid: '90000006', title: 'X', year: 2023, meshHeadings: ['Extracorporeal Membrane Oxygenation'] },
      { pmid: '90000007', title: 'Y', year: 2021, meshHeadings: ['Respiratory Insufficiency'] },
      { pmid: '90000008', title: 'Z', year: 2022, meshHeadings: ['Respiratory Insufficiency'] },
    ];
    const picks = await pickBoundaryCases(
      {
        researchQuestion: RESEARCH_QUESTION,
        inclusionCriteria: '成人, ARDS',
        exclusionCriteria: '小児',
        candidates,
      },
      makeProvider()
    );
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => candidates.some((c) => c.pmid === p.pmid))).toBe(true);
    expect(picks.every((p) => p.reason.trim() !== '')).toBe(true);
  });
});

describe('interpret-result フィクスチャ（08 章のブロック改善案、空にならない）', () => {
  it('90000005 に対して "Extracorporeal Membrane Oxygenation"[Mesh] をブロック #2 へ提案する', async () => {
    const v1 = buildBlockExpressions();
    const analyses = await interpretResult(
      {
        finalQuery: 'dummy',
        lines: [
          { blockId: '1', expression: v1.ards },
          { blockId: '2', expression: v1.ecmo },
          { blockId: '3', expression: v1.rct },
        ],
        missedArticles: [
          {
            pmid: '90000005',
            title: 'Venovenous extracorporeal life support for adult patients with ARDS',
            abstract: 'uses extracorporeal life support wording only',
            meshHeadings: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
          },
        ],
      },
      makeProvider()
    );
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.relatedBlock).toBe('2');
    expect(analyses[0]?.suggestedTerms).toEqual(['"Extracorporeal Membrane Oxygenation"[Mesh]']);
  });
});

describe('improve-block フィクスチャ（/edit の AI 改善）', () => {
  it('ECMO ブロックには MeSH タグ追加を提案する', async () => {
    const v1 = buildBlockExpressions();
    const proposal = await improveBlockExpression(
      {
        currentExpression: v1.ecmo,
        blockLabel: 'ECMO',
        blockDescription: getBlockDef('ecmo').blockDescription,
        researchQuestion: RESEARCH_QUESTION,
        userInstruction: '',
      },
      makeProvider()
    );
    expect(proposal.proposedExpression).toContain('Extracorporeal Membrane Oxygenation');
  });

  it('提案する式は v2-demo（buildFormulaV2）の #2 と完全一致する', async () => {
    // 操作解説動画の第 10 章は「AI 提案を採用 → 保存」を映し、第 11 章では v2-demo の
    // 式を映す。両者が別表記だと同じ検索式に見えないため、素朴な連結による表記ゆれ
    // （二重括弧・MeSH を外側に OR する等）が入らないことを固定する。
    const v1 = buildBlockExpressions();
    const proposal = await improveBlockExpression(
      {
        currentExpression: v1.ecmo,
        blockLabel: 'ECMO',
        blockDescription: getBlockDef('ecmo').blockDescription,
        researchQuestion: RESEARCH_QUESTION,
        userInstruction: '',
      },
      makeProvider()
    );
    expect(proposal.proposedExpression).toBe(
      buildBlockExpressions({ ecmo: [ECMO_MESH_ADDITION] }).ecmo
    );
  });
});

describe('プラン判定プローブ（第 2 章の tier バッジ）', () => {
  const probeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) =>
    handleGeminiGenerateContent(init ?? {})) as unknown as typeof fetch;

  it('detectGeminiTier が paid を返す（バッジが空欄にならない）', async () => {
    await expect(detectGeminiTier('demo-api-key', probeFetch)).resolves.toBe('paid');
  });

  it('systemInstruction を持たない maxOutputTokens=1 のリクエストは skill 判定へ流れない', async () => {
    const res = handleGeminiGenerateContent({
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
    expect(res.ok).toBe(true);
  });

  it('systemInstruction 付きのリクエストは従来どおり skill 判定される', () => {
    expect(() =>
      handleGeminiGenerateContent({
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          systemInstruction: { parts: [{ text: '未登録のシステムプロンプト' }] },
          generationConfig: { maxOutputTokens: 1 },
        }),
      })
    ).toThrow(/skill を判定できません/);
  });
});


describe('optimize-query フィクスチャ', () => {
  function input(): OptimizeQueryInput {
    return {
      formula: parsePubmedFormulaMd(buildFormulaV1().markdown),
      approvedBlocks: BLOCK_DEFS.map((block, index) => ({
        id: String(index + 1), approvedBlockId: String(index + 1), label: block.blockLabel,
      })),
      criteria: { researchQuestion: RESEARCH_QUESTION, inclusionCriteria: '成人 ARDS、ECMO', exclusionCriteria: '小児' },
      maxHits: 100,
      measurement: { id: 'demo-measurement', fingerprint: 'v1', measuredAt: '2026-01-01T00:00:00Z',
        totalHits: 4, capturedPmids: SEED_PMIDS.slice(0, 4), missedPmids: ['90000005'], blocks: [] },
    };
  }

  it('実際の skill のプロンプトを判定し、決定的な MeSH 追加と測定参照を返す', async () => {
    const before = input();
    const proposal = await optimizeQuery(before, makeProvider());
    expect(proposal).toEqual({
      targetBlockId: '2',
      proposedExpression: `(${before.formula.blocks[1]!.expression}) OR ${ECMO_MESH_ADDITION.tagSyntax}`,
      addedTerms: [ECMO_MESH_ADDITION.tagSyntax], removedTerms: [], replacedTerms: [],
      rationale: expect.stringContaining('成人 ARDS'), measurementIds: ['demo-measurement'], meshRequests: [],
    });
    expect(await optimizeQuery(before, makeProvider())).toEqual(proposal);
    before.formula.blocks[1]!.expression = proposal.proposedExpression;
    expect(await optimizeQuery(before, makeProvider())).toMatchObject({
      proposedExpression: proposal.proposedExpression, addedTerms: [], rationale: expect.stringContaining('追加済み'),
    });
  });

  it('固定の ID ではなく承認済み ECMO 行を対象にし、未計測時には測定 ID を捏造しない', async () => {
    const current = input();
    current.formula.blocks[1]!.id = 'treatment';
    current.approvedBlocks[1]!.id = 'treatment';
    current.measurement = undefined;
    expect(await optimizeQuery(current, makeProvider())).toMatchObject({ targetBlockId: 'treatment', measurementIds: [] });
    current.approvedBlocks = current.approvedBlocks.filter((block) => block.id !== 'treatment');
    await expect(optimizeQuery(current, makeProvider())).rejects.toThrow('承認済みの ECMO ブロックがありません');
  });

  it('デモの AND/OR/NOT と uid 交差で、追加文献・削除ゼロ・シード捕捉表を実測する', async () => {
    const before = input();
    const proposal = await optimizeQuery(before, makeProvider());
    const after = { ...before.formula, blocks: before.formula.blocks.map((block) =>
      block.id === proposal.targetBlockId ? { ...block, expression: proposal.proposedExpression } : block) };
    const eutils = { fetch: demoFetch, rateLimiter: { acquire: async () => undefined } };
    const original = expandFormula(before.formula);
    const candidate = expandFormula(after);
    expect(await esearch(original, eutils, { retmax: 20 })).toEqual({ count: 4, pmids: SEED_PMIDS.slice(0, 4) });
    expect(await esearch(candidate, eutils, { retmax: 20 })).toEqual({ count: 6, pmids: [...SEED_PMIDS, '90000006'] });
    expect(await esearch(`(${original}) NOT (${candidate})`, eutils, { retmax: 10000 })).toEqual({ count: 0, pmids: [] });
    expect(await esearch(`(${candidate}) NOT (${original})`, eutils, { retmax: 20 }))
      .toEqual({ count: 2, pmids: ['90000005', '90000006'] });
    const seeds = SEED_PMIDS.map((pmid) => `${pmid}[uid]`).join(' OR ');
    expect(await esearch(`(${before.formula.blocks[1]!.expression}) AND (${seeds})`, eutils, { retmax: 20 }))
      .toEqual({ count: 4, pmids: SEED_PMIDS.slice(0, 4) });
    expect(await esearch(`(${proposal.proposedExpression}) AND (${seeds})`, eutils, { retmax: 20 }))
      .toEqual({ count: 5, pmids: [...SEED_PMIDS] });
  });

  it('未生成のプリセットから自動調整・最終レビュー・採用保存・作り直しと検証まで完走する', async () => {
    const originalFetch = globalThis.fetch;
    const data: Record<string, unknown> = {};
    jest.spyOn(chrome.storage.local, 'get').mockImplementation(async () => data);
    jest.spyOn(chrome.storage.local, 'set').mockImplementation(async (items) => { Object.assign(data, items); });
    // 時間待ちだけを省く。Gemini・Sheets・NCBI の応答はすべて実際のデモ層を通す。
    jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
    globalThis.fetch = demoFetch;
    const runtime: ChromeRuntimeDeps = {
      google: { fetch: demoFetch, getAccessToken: async () => 'demo-access-token' },
      profile: { getProfileUserInfo: async () => ({ email: 'demo@example.com', id: 'demo' }) },
      store: { read: async <T>(key: string) => data[key] as T | undefined,
        write: async (items) => { Object.assign(data, items); } },
    };
    const doc = document.implementation.createHTMLDocument('デモの自動調整');
    doc.body.innerHTML = '<main id="app-content"></main>';
    let app: ReturnType<typeof startApp> | undefined;
    let unsubscribe: (() => void) | undefined;
    const waitUntil = async (ready: () => boolean): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`デモの処理が完了しません: ${doc.body.textContent}`);
    };
    try {
      await applyDemoSeed('07-draft');
      app = startApp(doc, { runtime, getHash: () => '#/draft', onHashChange: () => () => undefined, setHash: jest.fn() });
      const store = app.store;
      await waitUntil(() => store.getState().queryOptimizationSetup?.status === 'ready');
      expect(store.getState().currentFormulaMarkdown).toBeNull();
      expect(doc.querySelector('.draft__actions')).toBeNull();
      await runOptimizeQuery(store, runtime, { google: runtime.google, store: runtime.store }, { maxHits: 100, maxIterations: 1 });
      const run = store.getState().queryOptimizationRun!;
      expect(run.error).toBeNull();
      expect(run.result).toMatchObject({ status: 'achieved', iterations: 1,
        best: { measurement: { totalHits: 6, capturedPmids: [...SEED_PMIDS] } } });
      expect(run.trials.map((trial) => trial.kind)).toEqual(['initial', 'proposal', 'final']);
      expect(run.trials[1]).toMatchObject({ accepted: true, impact: { lostHits: 0, gainedHits: 2 } });
      expect(run.outsideCheck?.status).toBe('ready');
      expect(doc.querySelector('.optimization__review h3')?.textContent).toContain('目安件数と既知シードの捕捉を満たしました');
      await adoptQueryOptimization({ store, google: runtime.google });
      expect(store.getState().queryOptimizationRun?.save?.status).toBe('saved');
      expect(doc.querySelector('.optimization__save-status')?.textContent).toContain('保存しました');
      const liveHits: number[] = [];
      unsubscribe = store.subscribe(() => {
        if (store.getState().draftRun?.blockHits.length === 3) {
          liveHits.push(doc.querySelectorAll('.draft__block-hit--done').length);
        }
      });
      doc.querySelector<HTMLButtonElement>('.draft__generate')!.click();
      await waitUntil(() => !!doc.querySelector('.draft__validate-status') || !!store.getState().draftRun?.error);
      expect(store.getState().draftRun?.error).toBeFalsy();
      expect(liveHits).toContain(3);
      expect(doc.querySelector('.draft__validate-status')).not.toBeNull();
      expect(store.getState().validationResult?.summary.finalQuery).toMatchObject({ totalHits: 4, captureRate: 0.8 });
    } finally {
      unsubscribe?.();
      app?.dispose();
      globalThis.fetch = originalFetch;
      jest.restoreAllMocks();
    }
  });
});
