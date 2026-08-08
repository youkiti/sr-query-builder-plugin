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
import { BLOCK_DEFS, RESEARCH_QUESTION, buildBlockExpressions, getBlockDef } from './scenario';

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
