import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { pickBoundaryCases, type BoundaryCandidate } from './pickBoundaryCases';

function provider(text: string): { provider: LLMProvider; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    provider: {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push([...messages]);
        return { text, tokensIn: null, tokensOut: null, raw: {} };
      },
    },
  };
}

const candidates: BoundaryCandidate[] = [
  { pmid: '111', title: 'Paper A', year: 2020, meshHeadings: ['Asthma'] },
  { pmid: '222', title: 'Paper B', year: null, meshHeadings: [] },
  { pmid: '333', title: null, year: 2022, meshHeadings: ['Asthma', 'Child', 'Adolescent', 'Adult', 'Elderly', 'Extra'] },
];

describe('pickBoundaryCases', () => {
  test('候補が 0 件なら LLM を呼ばず空配列を返す', async () => {
    const calls: ChatMessage[][] = [];
    const p: LLMProvider = {
      providerId: 'gemini',
      model: 't',
      chat: async (m) => {
        calls.push([...m]);
        return { text: '{}', tokensIn: null, tokensOut: null, raw: {} };
      },
    };
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates: [],
      },
      p
    );
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('pmid・理由を返す', async () => {
    const json = JSON.stringify({
      picks: [
        { pmid: '111', reason: '対象集団が一部のみ一致' },
        { pmid: '222', reason: '介入が類似だが異なる' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates,
      },
      p
    );
    expect(result).toEqual([
      { pmid: '111', reason: '対象集団が一部のみ一致' },
      { pmid: '222', reason: '介入が類似だが異なる' },
    ]);
  });

  test('候補外の pmid は無視する', async () => {
    const json = JSON.stringify({
      picks: [
        { pmid: '999', reason: 'not in list' },
        { pmid: '111', reason: 'ok' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates,
      },
      p
    );
    expect(result).toEqual([{ pmid: '111', reason: 'ok' }]);
  });

  test('limit を超える分は切り捨てる', async () => {
    const json = JSON.stringify({
      picks: [
        { pmid: '111', reason: 'a' },
        { pmid: '222', reason: 'b' },
        { pmid: '333', reason: 'c' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates,
        limit: 2,
      },
      p
    );
    expect(result.map((p) => p.pmid)).toEqual(['111', '222']);
  });

  test('limit 未指定なら既定 5', async () => {
    const picks = Array.from({ length: 8 }, (_, i) => ({ pmid: String(100 + i), reason: 'r' }));
    const extra: BoundaryCandidate[] = picks.map((p) => ({
      pmid: p.pmid,
      title: null,
      year: null,
      meshHeadings: [],
    }));
    const { provider: p } = provider(JSON.stringify({ picks }));
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates: extra,
      },
      p
    );
    expect(result).toHaveLength(5);
  });

  test('picks 欠落や reason 欠落でも落ちない', async () => {
    const { provider: p } = provider('{}');
    const empty = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        candidates,
      },
      p
    );
    expect(empty).toEqual([]);

    const { provider: p2 } = provider(JSON.stringify({ picks: [{ pmid: '111' }] }));
    const r = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        candidates,
      },
      p2
    );
    expect(r).toEqual([{ pmid: '111', reason: '' }]);
  });

  test('limit が不正値の場合は既定にフォールバック', async () => {
    const picks = Array.from({ length: 7 }, (_, i) => ({ pmid: String(100 + i), reason: 'r' }));
    const extra: BoundaryCandidate[] = picks.map((p) => ({
      pmid: p.pmid,
      title: null,
      year: null,
      meshHeadings: [],
    }));
    const { provider: p } = provider(JSON.stringify({ picks }));
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates: extra,
        limit: 0,
      },
      p
    );
    expect(result).toHaveLength(5);
  });

  test('limit が上限超えなら最大 10 でキャップ', async () => {
    const picks = Array.from({ length: 15 }, (_, i) => ({ pmid: String(200 + i), reason: 'r' }));
    const extra: BoundaryCandidate[] = picks.map((p) => ({
      pmid: p.pmid,
      title: null,
      year: null,
      meshHeadings: [],
    }));
    const { provider: p } = provider(JSON.stringify({ picks }));
    const result = await pickBoundaryCases(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates: extra,
        limit: 999,
      },
      p
    );
    expect(result).toHaveLength(10);
  });

  test('プロンプトに候補情報と criteria が埋め込まれる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({ picks: [] }));
    await pickBoundaryCases(
      {
        researchQuestion: 'RQ-X',
        inclusionCriteria: '',
        exclusionCriteria: '',
        candidates,
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('RQ-X');
    expect(userMsg).toContain('PMID 111');
    expect(userMsg).toContain('Paper A');
    expect(userMsg).toContain('PMID 222');
    expect(userMsg).toContain('(未記載)');
    // MeSH は先頭 5 件まで
    expect(userMsg).toContain('Asthma, Child, Adolescent, Adult, Elderly');
    expect(userMsg).not.toContain('Extra');
    // title null のときは (no title) プレースホルダ
    expect(userMsg).toContain('(no title)');
    // テンプレート変数が残らない
    expect(userMsg).not.toContain('{{RQ}}');
  });
});
