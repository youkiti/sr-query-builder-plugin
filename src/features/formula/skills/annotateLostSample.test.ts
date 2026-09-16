import type { LLMProvider } from '@/lib/llm';
import { annotateLostSample, ANNOTATE_LOST_SAMPLE_SYSTEM_PROMPT, type AnnotateLostSampleInput } from './annotateLostSample';

const input: AnnotateLostSampleInput = {
  criteria: { researchQuestion: '研究課題', inclusionCriteria: '組入', exclusionCriteria: '除外' },
  articles: ['1', '2', '3'].map((pmid) => ({ pmid, title: '研究', year: 2024, abstract: null, meshHeadings: ['Disease'] })),
};
function fixture(items: unknown[] = []) {
  const chat = jest.fn().mockResolvedValue({ text: JSON.stringify({ items }), tokensIn: null, tokensOut: null, raw: {} });
  const provider: LLMProvider = { providerId: 'gemini', model: 'test', chat };
  return { chat, provider };
}

test('空の標本は通信しない', async () => {
  const f = fixture();
  expect(await annotateLostSample({ ...input, articles: [] }, f.provider)).toEqual([]);
  expect(f.chat).not.toHaveBeenCalled();
});

test('入力外・重複を捨て、不正な判定は判断不能、応答のない PMID は未注釈にする', async () => {
  const f = fixture([
    { pmid: '99', judgement: 'likely_eligible', reason: '入力外' },
    { pmid: '1', judgement: 'invalid', reason: '情報不足。' },
    { pmid: '1', judgement: 'likely_eligible', reason: '重複' },
    { pmid: '2', judgement: 'likely_ineligible', reason: '基準と異なる。' },
  ]);
  expect(await annotateLostSample(input, f.provider)).toEqual([
    { pmid: '1', judgement: 'unclear', reason: '情報不足。' },
    { pmid: '2', judgement: 'likely_ineligible', reason: '基準と異なる。' },
  ]);
});

test('抄録を 1500 文字に切り詰め、研究基準・system prompt・スキーマを渡す', async () => {
  const f = fixture([{ pmid: '1', judgement: 'likely_eligible', reason: '基準と一致する。' }]);
  const articles = [{ ...input.articles[0]!, abstract: 'あ'.repeat(1500) + '切り捨て部分' }, input.articles[1]!];
  expect(await annotateLostSample({ ...input, articles }, f.provider)).toHaveLength(1);
  const [messages, options] = f.chat.mock.calls[0]!;
  expect(messages[0]).toEqual({ role: 'system', content: ANNOTATE_LOST_SAMPLE_SYSTEM_PROMPT });
  expect(messages[1].content).toContain('あ'.repeat(1500));
  expect(messages[1].content).not.toContain('切り捨て部分');
  expect(messages[1].content).toContain('"abstract":null');
  for (const text of ['研究課題', '組入', '除外', 'Disease']) expect(messages[1].content).toContain(text);
  expect(options).toMatchObject({ responseFormat: 'json', temperature: 0.3, responseSchema: {
    type: 'object', properties: { items: { type: 'array', items: { properties: {
      judgement: { enum: ['likely_eligible', 'likely_ineligible', 'unclear'] },
    } } } },
  } });
  expect(articles[0]!.abstract).toContain('切り捨て部分');
});
