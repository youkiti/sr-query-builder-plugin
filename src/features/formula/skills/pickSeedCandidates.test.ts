import type { ChatMessage, LLMProvider } from '@/lib/llm';
import type { BoundaryCandidate } from './pickBoundaryCases';
import { pickSeedCandidates } from './pickSeedCandidates';

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
  {
    pmid: '333',
    title: null,
    year: 2022,
    meshHeadings: ['Asthma', 'Child', 'Adolescent', 'Adult', 'Elderly', 'Extra'],
  },
];

describe('pickSeedCandidates', () => {
  test('候補が 0 件なら LLM を呼ばず空配列を返す', async () => {
    const { provider: p, calls } = provider('{}');
    const result = await pickSeedCandidates(
      { researchQuestion: 'RQ', inclusionCriteria: 'inc', exclusionCriteria: 'exc', candidates: [] },
      p
    );
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('pmid・理由を返す', async () => {
    const json = JSON.stringify({
      picks: [
        { pmid: '111', reason: '組入基準に明確に合致' },
        { pmid: '222', reason: '対象集団が一致する代表例' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await pickSeedCandidates(
      { researchQuestion: 'RQ', inclusionCriteria: 'inc', exclusionCriteria: 'exc', candidates },
      p
    );
    expect(result).toEqual([
      { pmid: '111', reason: '組入基準に明確に合致' },
      { pmid: '222', reason: '対象集団が一致する代表例' },
    ]);
  });

  test('候補外の pmid は無視し、limit を超える分は切り捨てる', async () => {
    const json = JSON.stringify({
      picks: [
        { pmid: '999', reason: 'not in list' },
        { pmid: '111', reason: 'a' },
        { pmid: '222', reason: 'b' },
        { pmid: '333', reason: 'c' },
      ],
    });
    const { provider: p } = provider(json);
    const result = await pickSeedCandidates(
      {
        researchQuestion: 'RQ',
        inclusionCriteria: 'inc',
        exclusionCriteria: 'exc',
        candidates,
        limit: 2,
      },
      p
    );
    expect(result.map((r) => r.pmid)).toEqual(['111', '222']);
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
    const result = await pickSeedCandidates(
      { researchQuestion: 'RQ', inclusionCriteria: 'inc', exclusionCriteria: 'exc', candidates: extra },
      p
    );
    expect(result).toHaveLength(5);
  });

  test('reason 欠落でも落ちない', async () => {
    const { provider: p } = provider(JSON.stringify({ picks: [{ pmid: '111' }] }));
    const r = await pickSeedCandidates(
      { researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', candidates },
      p
    );
    expect(r).toEqual([{ pmid: '111', reason: '' }]);
  });

  test('プロンプトに候補情報と criteria が埋め込まれ、テンプレ変数が残らない', async () => {
    const { provider: p, calls } = provider(JSON.stringify({ picks: [] }));
    await pickSeedCandidates(
      { researchQuestion: 'RQ-X', inclusionCriteria: '', exclusionCriteria: '', candidates },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('RQ-X');
    expect(userMsg).toContain('PMID 111');
    expect(userMsg).toContain('(未記載)');
    expect(userMsg).toContain('Asthma, Child, Adolescent, Adult, Elderly');
    expect(userMsg).not.toContain('Extra');
    expect(userMsg).not.toContain('{{RQ}}');
  });
});
