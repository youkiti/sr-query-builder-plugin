import type { LLMProvider } from '@/lib/llm';
import { optimizeQuery, type OptimizeQueryInput, type OptimizationMeasurement } from './optimizeQuery';

function setup(text = '{}') {
  const chat = jest.fn().mockResolvedValue({ text, tokensIn: null, tokensOut: null, raw: {} });
  const provider: LLMProvider = { providerId: 'gemini', model: 'test', chat };
  const input: OptimizeQueryInput = {
    formula: { blocks: [
      { id: '1', expression: 'drug$[tiab]', isCombination: false },
      { id: '2', expression: '#1', isCombination: true },
    ], combinationExpression: '#1' },
    approvedBlocks: [{ id: '1', approvedBlockId: 'approved-1', label: '疾患' }],
    criteria: { researchQuestion: '研究 RQ', inclusionCriteria: '成人', exclusionCriteria: '小児' },
    maxHits: 4321,
  };
  return { chat, provider, input };
}

function measurement(): OptimizationMeasurement {
  return { id: 'run:initial', fingerprint: 'hash', measuredAt: '2026-09-11', totalHits: 0,
    capturedPmids: [], missedPmids: ['11'], blocks: [{ id: '1', hits: null, error: '取得失敗' }],
    terms: [{ blockId: '1', query: 'drug$[tiab]', hits: 0, delta: null }] };
}

test('全式・承認対応・基準・上限をテンプレートへ安全に渡す', async () => {
  const { input, provider, chat } = setup();
  await optimizeQuery(input, provider);
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const value of ['drug$[tiab]', '#1', 'approved-1', '疾患', '研究 RQ', '成人', '小児', '4321', '(未計測)', '(渡されていない)', '(なし)']) {
    expect(prompt).toContain(value);
  }
  expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  expect(chat.mock.calls[0]![1]).toMatchObject({ responseFormat: 'json', temperature: 0.3,
    responseSchema: { type: 'object', additionalProperties: false } });
});

test('測定・書誌・MeSH の全枝と採否履歴を欠測を補完せず渡す', async () => {
  const { input, provider, chat } = setup();
  input.measurement = measurement();
  input.seedPapers = [{ pmid: '11', title: 'シード題名' }, { pmid: '22', title: null }];
  input.meshContext = [{ id: 'D001', descriptor: 'Asthma', label: 'Asthma',
    treeNumbers: ['C01.100', 'C02.200'], parentIds: ['D000'], childIds: ['D002'], explode: false, note: '子は一段のみ取得' }];
  input.trials = [
    { kind: 'proposal', apiEvents: [], candidateId: 'rejected', formula: input.formula, accepted: false, reason: 'シード喪失', rationale: '下位化',
      before: measurement(), after: { ...measurement(), totalHits: null, capturedPmids: null, missedPmids: null, terms: undefined } },
    { kind: 'proposal', apiEvents: [], candidateId: 'unmeasured', formula: input.formula, accepted: false, reason: '構文不正', rationale: '', before: null, after: null },
  ];
  await optimizeQuery(input, provider);
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const value of ['run:initial', 'hash', '取得失敗', 'シード題名', 'D001', 'C01.100', 'C02.200', 'D000', 'D002',
    '"explode": false', 'シード喪失', '構文不正', '"totalHits": 0', '"totalHits": "(未計測)"', '"delta": "(未計測)"', '"hits": 0']) {
    expect(prompt).toContain(value);
  }
});

test('snake_case の変更案を変換し、予想件数は出力型・スキーマに含めない', async () => {
  const { input, provider, chat } = setup(JSON.stringify({ target_block_id: ' 1 ', proposed_expression: ' new[tiab] ',
    added_terms: ['new'], removed_terms: ['old'], replaced_terms: [{ before: 'old', after: 'new' }],
    rationale: '基準に沿う語へ置換', measurement_ids: ['run:initial'], predicted_hits: 123 }));
  expect(await optimizeQuery(input, provider)).toEqual({ targetBlockId: '1', proposedExpression: 'new[tiab]',
    addedTerms: ['new'], removedTerms: ['old'], replacedTerms: [{ before: 'old', after: 'new' }],
    rationale: '基準に沿う語へ置換', measurementIds: ['run:initial'], meshRequests: [] });
  expect(JSON.stringify(chat.mock.calls[0]![1].responseSchema)).not.toContain('predicted');
});

test('欠落プロパティは既存スキル同様に空へフォールバックする', async () => {
  const { input, provider } = setup();
  expect(await optimizeQuery(input, provider)).toEqual({ targetBlockId: '', proposedExpression: '',
    addedTerms: [], removedTerms: [], replacedTerms: [], rationale: '', measurementIds: [], meshRequests: [] });
  const second = setup('{"replaced_terms":[{}]}');
  expect((await optimizeQuery(second.input, second.provider)).replacedTerms).toEqual([{ before: '', after: '' }]);
});

test('空の配列・基準を明示し、JSON 破損とプロバイダ失敗を伝播する', async () => {
  const { input, provider, chat } = setup();
  input.criteria.inclusionCriteria = '';
  input.seedPapers = [];
  input.meshContext = [];
  input.trials = [];
  await optimizeQuery(input, provider);
  expect(chat.mock.calls[0]![0][1].content).toContain('"inclusionCriteria": "(なし)"');
  chat.mockResolvedValueOnce({ text: 'bad json' });
  await expect(optimizeQuery(input, provider)).rejects.toThrow();
  chat.mockRejectedValueOnce(new Error('通信失敗'));
  await expect(optimizeQuery(input, provider)).rejects.toThrow('通信失敗');
});

test('追加情報の要求を変換し、descriptor または枝だけの指定と欠落を扱う', async () => {
  const { input, provider, chat } = setup(JSON.stringify({ mesh_requests: [
    { descriptor: ' Disease ', tree_number: ' C01.100 ' },
    { descriptor: 'Asthma' }, { tree_number: 'C02.200' }, {},
  ] }));
  const result = await optimizeQuery(input, provider);
  expect(result.meshRequests).toEqual([
    { descriptor: 'Disease', treeNumber: 'C01.100' },
    { descriptor: 'Asthma', treeNumber: '' }, { descriptor: '', treeNumber: 'C02.200' },
    { descriptor: '', treeNumber: '' },
  ]);
  expect(chat.mock.calls[0]![1].responseSchema.properties.mesh_requests).toEqual({
    type: 'array', items: expect.objectContaining({
      type: 'object', required: ['descriptor', 'tree_number'], additionalProperties: false,
    }),
  });
  expect(chat.mock.calls[0]![0][0].content).toContain('不要なら空配列');
  expect(chat.mock.calls[0]![0][1].content).toContain('"mesh_requests"');
});

test('未取得の理由を実在ノードと分けた文脈として渡す', async () => {
  const { input, provider, chat } = setup('{"mesh_requests":[]}');
  input.meshRequestResults = [{ request: { descriptor: 'Disease', treeNumber: 'C01.100' },
    note: '未取得: callback が未注入です' }];
  expect((await optimizeQuery(input, provider)).meshRequests).toEqual([]);
  expect(chat.mock.calls[0]![0][1].content).toContain('未取得: callback が未注入です');
});
