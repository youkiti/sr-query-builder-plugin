import { measureSet, setImpact } from '../../../../tests/fixtures/pubmedSets';
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

function measurement(pmids: readonly string[] = []): OptimizationMeasurement {
  const measured = measureSet(pmids, ['11']);
  return { id: 'run:initial', fingerprint: 'hash', measuredAt: '2026-09-11', ...measured, blocks: [{ id: '1', hits: null, error: '取得失敗' }],
    terms: [{ blockId: '1', query: 'drug$[tiab]', hits: measured.totalHits, delta: null }] };
}

test('全式・承認対応・基準・上限をテンプレートへ安全に渡す', async () => {
  const { input, provider, chat } = setup();
  await optimizeQuery(input, provider);
  const prompt = chat.mock.calls[0]![0][1].content as string;
  for (const value of ['drug$[tiab]', '#1', 'approved-1', '疾患', '研究 RQ', '成人', '小児', '4321', '(未計測)', '(渡されていない)', '(なし)']) {
    expect(prompt).toContain(value);
  }
  expect(prompt).toContain('目安件数（最終式の件数の目安。適格文献を落としてまで合わせない）: 4321');
  for (const rule of ['1 run で 3 件そろうと終了', '互いに異なる狭め方', 'rationale', '失う 0 件・増える 0 件']) {
    expect(chat.mock.calls[0]![0][0].content).toContain(rule);
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
    '"explode": false', 'シード喪失', '構文不正', '"totalHits": 0', '"delta": "(未計測)"', '"hits": 0']) {
    expect(prompt).toContain(value);
  }
  // 試行履歴は要約のみを渡す。全式・terms を含む測定 JSON はもう含まれない
  // （旧: 'rejected' 試行の after を formatMeasurement した生 JSON に "totalHits": "(未計測)" が出ていた）。
  expect(prompt).toContain('"afterHits":"未測定"');
  expect(prompt).not.toContain('"query":"drug$[tiab]"');
});

test('試行履歴の要約: finish の受け付け・拒否を outcome で区別する', async () => {
  const { input, provider, chat } = setup();
  input.trials = [
    { kind: 'finish', apiEvents: [], candidateId: 'finish-1', formula: input.formula, finishKind: 'no_change_needed',
      accepted: false, after: null, before: measurement(), reason: 'AI の終了判断（変更不要）', rationale: '冗長語は無い' },
    { kind: 'finish', apiEvents: [], candidateId: 'finish-2', formula: input.formula, finishKind: 'no_change_needed',
      finishRejectedReason: '受け付けませんでした: 目安件数を超えています', accepted: false, after: null, before: measurement(),
      reason: '受け付けませんでした: 目安件数を超えています', rationale: '冗長語は無い' },
  ];
  await optimizeQuery(input, provider);
  const prompt = chat.mock.calls[0]![0][1].content as string;
  const trialsSection = prompt.split('試行履歴（要約')[1]!;
  expect(trialsSection).toContain('"candidateId":"finish-1"');
  expect(trialsSection).toContain('"outcome":"終了判断"');
  expect(trialsSection).toContain('"candidateId":"finish-2"');
  expect(trialsSection).toContain('"outcome":"終了判断（受け付けず）"');
});

test('システムプロンプト: 全件捕捉・目安超過の間は no_change_needed を受け付けない旨を示す', async () => {
  const { input, provider, chat } = setup();
  await optimizeQuery(input, provider);
  const system = chat.mock.calls[0]![0][0].content as string;
  for (const text of ['既知シードを全件捕捉したまま目安件数を超えている間は no_change_needed を受け付けません',
    'needs_human_judgment は、語の変更では解決できない場合']) {
    expect(system).toContain(text);
  }
});

test('snake_case の変更案を変換し、予想件数は出力型・スキーマに含めない', async () => {
  const { input, provider, chat } = setup(JSON.stringify({ target_block_id: ' 1 ', proposed_expression: ' new[tiab] ',
    added_terms: ['new'], removed_terms: ['old'], replaced_terms: [{ before: 'old', after: 'new' }],
    rationale: '基準に沿う語へ置換', measurement_ids: ['run:initial'], predicted_hits: 123 }));
  expect(await optimizeQuery(input, provider)).toEqual({ action: 'propose_changes', targetBlockId: '1', proposedExpression: 'new[tiab]',
    addedTerms: ['new'], removedTerms: ['old'], replacedTerms: [{ before: 'old', after: 'new' }],
    rationale: '基準に沿う語へ置換', measurementIds: ['run:initial'] });
  expect(JSON.stringify(chat.mock.calls[0]![1].responseSchema)).not.toContain('predicted');
});

test('欠落プロパティは既存スキル同様に空へフォールバックする', async () => {
  const { input, provider } = setup();
  expect(await optimizeQuery(input, provider)).toEqual({ action: 'propose_changes', targetBlockId: '', proposedExpression: '',
    addedTerms: [], removedTerms: [], replacedTerms: [], rationale: '', measurementIds: [] });
  const second = setup('{"replaced_terms":[{}]}');
  const decision = await optimizeQuery(second.input, second.provider);
  if (decision.action !== 'propose_changes') throw new Error('propose_changes ではありません');
  expect(decision.replacedTerms).toEqual([{ before: '', after: '' }]);
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

test('追加情報の要求を変換し、descriptor または枝だけの指定と欠落を扱う（旧形式）', async () => {
  const { input, provider, chat } = setup(JSON.stringify({ mesh_requests: [
    { descriptor: ' Disease ', tree_number: ' C01.100 ' },
    { descriptor: 'Asthma' }, { tree_number: 'C02.200' }, {},
  ] }));
  const result = await optimizeQuery(input, provider);
  if (result.action !== 'request_context') throw new Error('request_context ではありません');
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

test('旧形式（action 無し）は trial_detail_ids を無視し、常に空配列にする', async () => {
  const { input, provider } = setup(JSON.stringify({
    mesh_requests: [{ descriptor: 'Disease' }], trial_detail_ids: ['candidate-1'],
  }));
  const result = await optimizeQuery(input, provider);
  if (result.action !== 'request_context') throw new Error('request_context ではありません');
  expect(result.trialDetailIds).toEqual([]);
});

test('未取得の理由を実在ノードと分けた文脈として渡す。mesh_requests が空の旧形式は propose_changes になる', async () => {
  const { input, provider, chat } = setup('{"mesh_requests":[]}');
  input.meshRequestResults = [{ request: { descriptor: 'Disease', treeNumber: 'C01.100' },
    note: '未取得: callback が未注入です' }];
  expect((await optimizeQuery(input, provider)).action).toBe('propose_changes');
  expect(chat.mock.calls[0]![0][1].content).toContain('未取得: callback が未注入です');
});


test('保留・却下・重複の変更一覧と変種の注記を実差分から渡す', async () => {
  const f = setup();
  const base = { kind: 'proposal' as const, apiEvents: [], formula: f.input.formula, accepted: false,
    rationale: '', before: measurement(), after: measurement(), reason: '局面の指標に改善がありません' };
  f.input.trials = [
    { ...base, candidateId: 'candidate-1', held: true,
      before: measurement(['901', '902', '903']), after: measurement([]),
      impact: setImpact(['901', '902', '903'], []),
      formulaDiff: [{ blockId: '2', removed: ['"Diabetic Retinopathy"[Mesh]'], added: [] }] },
    { ...base, candidateId: 'candidate-2',
      formulaDiff: [{ blockId: '2', removed: ['"Diabetic Retinopathy"[Mesh]'], added: ['b[tiab]'] }] },
    { ...base, candidateId: 'candidate-3', duplicateOf: 'candidate-1', after: null,
      formulaDiff: [{ blockId: '2', removed: ['"Diabetic Retinopathy"[Mesh]'], added: [] }] },
    { ...base, candidateId: 'candidate-4', duplicateOf: 'candidate-1', after: null, formulaDiff: [] },
    { ...base, candidateId: 'candidate-5', duplicateOf: 'candidate-1', after: null },
    { ...base, candidateId: 'accepted', accepted: true },
  ];
  await optimizeQuery(f.input, f.provider);
  const prompt = f.chat.mock.calls[0]![0][1].content as string;
  const list = prompt.split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!;
  expect(list.split('\n')).toHaveLength(6);
  expect(list).toContain('candidate-1 / #2 削除: "Diabetic Retinopathy"[Mesh] / 追加: なし / 結果: 保留（失う 3 件・増える 0 件）');
  expect(list).toContain('（candidate-1 と同じ削除の変種） / 結果: 却下（局面の指標に改善がありません）');
  expect(list).toContain('candidate-3 / #2 削除: "Diabetic Retinopathy"[Mesh] / 追加: なし（candidate-1 と同じ式） / 結果: 測定せずに却下');
  expect(list).toContain('candidate-4 / 変更なし（candidate-1 と同じ式） / 結果: 測定せずに却下');
  expect(list).toContain('candidate-5 / 変更差分の記録なし（candidate-1 と同じ式） / 結果: 測定せずに却下');
  expect(list.split('\n').filter((line) => line.includes('測定せずに却下')).every((line) => !line.includes('同じ削除の変種'))).toBe(true);
  const system = f.chat.mock.calls[0]![0][0].content as string;
  for (const text of ['測定せずに却下', '失う集合が残る限り再び保留', '特異的な語と AND', '下位の MeSH', '採否は実測で決まります']) expect(system).toContain(text);
  // 試行履歴は要約であることと、詳細は trial_detail_ids で取り出せることが分かる見出しに変えた
  // （旧: '試行履歴（採否・却下理由・前後の実測）'）。
  expect(prompt).toContain('試行履歴（要約。採否・却下理由・前後件数のみ。全式・全測定は request_context の trial_detail_ids で取り出せます）');
});

test.each(['同じ', '別ブロック', '結合式'] as const)('保留の変更後の式と現在の式との関係を渡す（%s）', async (difference) => {
  const f = setup();
  const formula = { blocks: [
    { id: '1', expression: 'disease[tiab]', isCombination: false },
    { id: '2', expression: 'drug[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' };
  const expression = '(drug[tiab] OR treatment[tiab]) AND specific[tiab]';
  f.input.formula = { ...formula,
    blocks: formula.blocks.map((block) => difference === '別ブロック' && block.id === '1'
      ? { ...block, expression: 'other[tiab]' } : block),
    combinationExpression: difference === '結合式' ? '#1 OR #2' : formula.combinationExpression };
  f.input.trials = [{ kind: 'proposal', apiEvents: [], candidateId: 'candidate-1', accepted: false,
    held: true, before: measurement(), after: measurement(), reason: '保留', rationale: '',
    formula: { ...formula, blocks: formula.blocks.map((block) => block.id === '2' ? { ...block, expression } : block) },
    changes: { targetBlockId: '2', addedTerms: [], removedTerms: [], replacedTerms: [] },
    formulaDiff: [{ blockId: '2', removed: [], added: ['specific[tiab]'] }] }];
  await optimizeQuery(f.input, f.provider);
  const list = (f.chat.mock.calls[0]![0][1].content as string).split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!;
  expect(list).toContain(` / 変更後の式: #2 = ${expression} / 現在の式との関係: ${difference === '同じ'
    ? 'このブロック以外は現在の式と同じ（同じブロックにこの式を出すと同一式）' : '他のブロックが現在の式と異なる'}`);
  expect(list).not.toContain('注意:');
  expect(list.match(/#2 = /g)).toHaveLength(1);
});

test('演算子だけの変更で差分が空でも、保留の対象ブロックの式と現在の式との関係を渡す', async () => {
  const f = setup();
  f.input.formula = { blocks: [
    { id: '1', expression: 'disease[tiab]', isCombination: false },
    { id: '2', expression: 'drug[tiab] OR treatment[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' };
  f.input.trials = [{ kind: 'proposal', apiEvents: [], candidateId: 'operator-only', accepted: false,
    held: true, before: measurement(), after: measurement(), reason: '保留', rationale: '',
    formula: { ...f.input.formula, blocks: f.input.formula.blocks.map((block) => block.id === '2'
      ? { ...block, expression: 'drug[tiab] AND treatment[tiab]' } : block) },
    formulaDiff: [], changes: { targetBlockId: '2', addedTerms: [], removedTerms: [], replacedTerms: [] } }];
  await optimizeQuery(f.input, f.provider);
  const list = (f.chat.mock.calls[0]![0][1].content as string).split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!;
  expect(list).toContain('変更後の式: #2 = drug[tiab] AND treatment[tiab] / 現在の式との関係: このブロック以外は現在の式と同じ（同じブロックにこの式を出すと同一式）');
});

test('一覧内の重複は式を繰り返さず、初期式の重複は式と関係を載せ、先頭で対応を注意する', async () => {
  const f = setup();
  f.input.formula = { blocks: [
    { id: '1', expression: 'disease[tiab]', isCombination: false },
    { id: '2', expression: 'drug[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' };
  const base = { kind: 'proposal' as const, apiEvents: [], accepted: false, before: null, after: null,
    reason: '保留', rationale: '', formula: f.input.formula,
    formulaDiff: [{ blockId: '2', removed: [], added: [] }] };
  f.input.trials = [
    { ...base, candidateId: 'candidate-1', held: true },
    { ...base, candidateId: 'candidate-3', duplicateOf: 'candidate-1' },
    { ...base, candidateId: 'candidate-4', duplicateOf: 'initial' },
  ];
  await optimizeQuery(f.input, f.provider);
  const lines = (f.chat.mock.calls[0]![0][1].content as string).split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!.split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe('注意: 評価済みの式と同じ式を再提案し、測定せずに却下した回が 2 回あります（candidate-3 → candidate-1, candidate-4 → initial）。同一式の再提案は改善なし（採用にも保留にもならない回）に数えられ、2 回続くと run は停止します。各行の「変更後の式」と同じ式を出さないでください。');
  expect(lines[1]).toContain('変更後の式: #2 = drug[tiab]');
  expect(lines[2]).not.toMatch(/変更後の式|現在の式との関係/);
  expect(lines[3]).toContain('変更後の式: #2 = drug[tiab] / 現在の式との関係: このブロック以外は現在の式と同じ');
});

test('変更差分と変更案の対象 ID を使い、非結合ブロックが特定できない試行には式と関係を載せない', async () => {
  const f = setup();
  f.input.formula = { blocks: [
    { id: '1', expression: 'disease[tiab]', isCombination: false },
    { id: '2', expression: 'drug[tiab]', isCombination: false },
    { id: '3', expression: '#1 AND #2', isCombination: true },
  ], combinationExpression: '#1 AND #2' };
  const base = { kind: 'proposal' as const, apiEvents: [], accepted: false, before: null, after: null,
    reason: '却下', rationale: '', formula: f.input.formula,
    changes: { targetBlockId: '2', addedTerms: [], removedTerms: [], replacedTerms: [] } };
  f.input.trials = [
    { ...base, candidateId: 'error', responseError: '応答不正', changes: { ...base.changes, targetBlockId: '' } },
    { ...base, candidateId: 'empty', formulaDiff: [] },
    { ...base, candidateId: 'legacy' },
    { ...base, candidateId: 'combination', changes: { ...base.changes, targetBlockId: '3' } },
    { ...base, candidateId: 'missing', formulaDiff: [{ blockId: '4', added: [], removed: [] }] },
    { ...base, candidateId: 'empty-without-changes', formulaDiff: [], changes: undefined },
    { ...base, candidateId: 'without-changes', changes: undefined },
    { ...base, candidateId: 'missing-without-changes', formulaDiff: [{ blockId: '4', added: [], removed: [] }], changes: undefined },
  ];
  await optimizeQuery(f.input, f.provider);
  const lines = (f.chat.mock.calls[0]![0][1].content as string).split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!.split('\n');
  for (const index of [0, 3, 5, 6, 7]) expect(lines[index]).not.toMatch(/変更後の式|現在の式との関係/);
  for (const index of [1, 2, 4]) expect(lines[index]).toContain('変更後の式: #2 = drug[tiab] / 現在の式との関係: このブロック以外は現在の式と同じ');
});

test('システムプロンプトは保留済みの式を再提案せず異なる狭め方を出すよう指示する', async () => {
  const f = setup();
  await optimizeQuery(f.input, f.provider);
  const system = f.chat.mock.calls[0]![0][0].content as string;
  expect(system).toContain('新しい保留候補にはならないので出さないでください');
  expect(system).toContain('一覧のどの式とも異なる狭め方を出してください');
});

test('変更一覧が空ならなし、長い差分はブロックごとに省略する', async () => {
  const f = setup();
  await optimizeQuery(f.input, f.provider);
  expect(f.chat.mock.calls[0]![0][1].content).toContain('保留・却下した変更の一覧:\n(なし)');
  f.input.trials = [{ kind: 'proposal', apiEvents: [], candidateId: 'long', formula: f.input.formula,
    accepted: false, before: null, after: null, reason: '構文不正', rationale: '',
    formulaDiff: [{ blockId: '1', removed: Array.from({ length: 12 }, (_, i) => `word${i}[tiab]`), added: [] },
      { blockId: '2', removed: [], added: ['new[tiab]'] }] }];
  await optimizeQuery(f.input, f.provider);
  const list = (f.chat.mock.calls[1]![0][1].content as string).split('保留・却下した変更の一覧:\n')[1]!.split('\n試行履歴')[0]!;
  expect(list).toContain('word9[tiab]、ほか 2 語');
  expect(list).not.toContain('word10');
  expect(list).toContain(' ; #2 削除: なし / 追加: new[tiab]');
});

test('機械的な診断を一件一行で渡し、狭め方と保留の規則を示す', async () => {
  const { input, provider, chat } = setup();
  input.blockDiagnosis = { fingerprint: 'fp', note: '', overlaps: [
    { blockIds: ['1', '2'], kind: 'same', terms: [], qualified: true, note: '#1 と #2: 同じ MeSH "Disease"[Mesh]' },
  ], narrowing: [
    { blockId: '1', label: '疾患', finalHits: 11000, withoutHits: 12345, reduction: 1345 / 12345, ineffective: true, note: '' },
    { blockId: '2', label: '治療', finalHits: 11000, withoutHits: null, reduction: null, ineffective: null, note: '未判定: 測定失敗' },
  ] };
  await optimizeQuery(input, provider);
  const prompt = chat.mock.calls[0]![0][1].content as string;
  expect(prompt).toContain('ブロック構造の診断（機械的な検出。AI の判断ではない）');
  expect(prompt).toContain('#1 と #2: 同じ MeSH "Disease"[Mesh]（修飾付き）');
  expect(prompt).toContain('外すと 12,345 件 → 最終式 11,000 件（削減率 10.9%）');
  expect(prompt).toContain('未判定: 測定失敗');
  const system = chat.mock.calls[0]![0][0].content as string;
  expect(system).toContain('特異的な語との AND・下位の MeSH への置換');
  expect(system).toContain('上位語でしか索引されない適格文献');
});

describe('行動種別 (action)', () => {
  test('request_context の正常系: mesh_requests だけを持つ決定を返す', async () => {
    const { input, provider } = setup(JSON.stringify({ action: 'request_context',
      mesh_requests: [{ descriptor: 'Disease', tree_number: '' }], rationale: '周辺を確認したい',
      measurement_ids: ['run:initial'] }));
    expect(await optimizeQuery(input, provider)).toEqual({ action: 'request_context',
      meshRequests: [{ descriptor: 'Disease', treeNumber: '' }], trialDetailIds: [],
      rationale: '周辺を確認したい', measurementIds: ['run:initial'] });
  });

  test('request_context の正常系: trial_detail_ids だけでも成立する（mesh_requests は空でよい）', async () => {
    const { input, provider } = setup(JSON.stringify({ action: 'request_context',
      mesh_requests: [], trial_detail_ids: [' candidate-1 ', 'candidate-2', ''],
      rationale: '候補の全式を確認したい', measurement_ids: [] }));
    expect(await optimizeQuery(input, provider)).toEqual({ action: 'request_context',
      meshRequests: [], trialDetailIds: ['candidate-1', 'candidate-2'],
      rationale: '候補の全式を確認したい', measurementIds: [] });
  });

  test('propose_changes の正常系: 変更案だけを持つ決定を返す', async () => {
    const { input, provider } = setup(JSON.stringify({ action: 'propose_changes',
      target_block_id: '1', proposed_expression: 'new[tiab]', added_terms: ['new'], removed_terms: [],
      replaced_terms: [], rationale: '基準に沿う語へ置換', measurement_ids: [] }));
    expect(await optimizeQuery(input, provider)).toEqual({ action: 'propose_changes', targetBlockId: '1',
      proposedExpression: 'new[tiab]', addedTerms: ['new'], removedTerms: [], replacedTerms: [],
      rationale: '基準に沿う語へ置換', measurementIds: [] });
  });

  test.each(['no_change_needed', 'needs_human_judgment'] as const)('finish(%s) の正常系: 区分と理由だけを持つ決定を返す', async (finishKind) => {
    const { input, provider } = setup(JSON.stringify({ action: 'finish', finish_kind: finishKind,
      rationale: '分析の結果、修正不要と判断', measurement_ids: ['run:initial'] }));
    expect(await optimizeQuery(input, provider)).toEqual({ action: 'finish', finishKind,
      rationale: '分析の結果、修正不要と判断', measurementIds: ['run:initial'] });
  });

  test('未知の action は例外にせず invalid を返す', async () => {
    const { input, provider } = setup(JSON.stringify({ action: 'do_something_else', rationale: '謎の応答' }));
    const decision = await optimizeQuery(input, provider);
    expect(decision).toMatchObject({ action: 'invalid', rationale: '謎の応答' });
    if (decision.action !== 'invalid') throw new Error('invalid ではありません');
    expect(decision.reason).toContain('do_something_else');
  });

  test.each([
    ['request_context に proposed_expression が混在', { action: 'request_context', mesh_requests: [{ descriptor: 'Disease' }], proposed_expression: 'x[tiab]' }, '混在'],
    ['request_context に added_terms が混在', { action: 'request_context', mesh_requests: [{ descriptor: 'Disease' }], added_terms: ['x'] }, '混在'],
    ['request_context に mesh_requests と trial_detail_ids のどちらも無い', { action: 'request_context', mesh_requests: [] }, 'mesh_requests と trial_detail_ids のどちらもありません'],
    ['request_context の trial_detail_ids が空文字だけ', { action: 'request_context', mesh_requests: [], trial_detail_ids: [' ', ''] }, 'mesh_requests と trial_detail_ids のどちらもありません'],
    ['propose_changes に mesh_requests が混在', { action: 'propose_changes', target_block_id: '1', proposed_expression: 'x[tiab]', mesh_requests: [{ descriptor: 'Disease' }] }, '混在'],
    ['propose_changes に trial_detail_ids が混在', { action: 'propose_changes', target_block_id: '1', proposed_expression: 'x[tiab]', trial_detail_ids: ['candidate-1'] }, '混在'],
    ['propose_changes に target_block_id が無い', { action: 'propose_changes', proposed_expression: 'x[tiab]' }, 'target_block_id または proposed_expression'],
    ['propose_changes に proposed_expression が無い', { action: 'propose_changes', target_block_id: '1' }, 'target_block_id または proposed_expression'],
    ['finish に mesh_requests が混在', { action: 'finish', finish_kind: 'no_change_needed', rationale: '理由', mesh_requests: [{ descriptor: 'Disease' }] }, '混在'],
    ['finish に trial_detail_ids が混在', { action: 'finish', finish_kind: 'no_change_needed', rationale: '理由', trial_detail_ids: ['candidate-1'] }, '混在'],
    ['finish に added_terms が混在', { action: 'finish', finish_kind: 'no_change_needed', rationale: '理由', added_terms: ['x'] }, '混在'],
    ['finish の finish_kind が無い（not_applicable のまま）', { action: 'finish', finish_kind: 'not_applicable', rationale: '理由' }, 'finish_kind がありません'],
    ['finish の finish_kind が不明な値', { action: 'finish', finish_kind: 'unknown_kind', rationale: '理由' }, 'finish_kind がありません'],
    ['finish に rationale が無い', { action: 'finish', finish_kind: 'no_change_needed' }, '終了理由'],
  ] as const)('%s は例外にせず invalid を返す', async (_label, body, reasonSubstring) => {
    const { input, provider } = setup(JSON.stringify(body));
    const decision = await optimizeQuery(input, provider);
    expect(decision.action).toBe('invalid');
    if (decision.action !== 'invalid') throw new Error('invalid ではありません');
    expect(decision.reason).toContain(reasonSubstring);
  });

  test('スキーマに action・finish_kind の enum を含む', async () => {
    const { input, provider, chat } = setup();
    await optimizeQuery(input, provider);
    const schema = chat.mock.calls[0]![1].responseSchema;
    expect(schema.properties.action).toMatchObject({ type: 'string', enum: ['request_context', 'propose_changes', 'finish'] });
    expect(schema.properties.finish_kind).toMatchObject({ type: 'string',
      enum: ['not_applicable', 'no_change_needed', 'needs_human_judgment'] });
    expect(schema.required).toContain('action');
    expect(schema.required).toContain('finish_kind');
    expect(schema.properties.trial_detail_ids).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(schema.required).toContain('trial_detail_ids');
  });
});

describe('trial_detail_ids で取り出した試行詳細（TRIAL_DETAILS 節）', () => {
  test('要求が無ければ (要求なし) を渡す', async () => {
    const { input, provider, chat } = setup();
    await optimizeQuery(input, provider);
    const prompt = chat.mock.calls[0]![0][1].content as string;
    expect(prompt.split('要求した試行の詳細')[1]).toContain('(要求なし)');
  });

  test('取得できた詳細は全式・前後の実測・削除影響・rationale の全文を渡す', async () => {
    const { input, provider, chat } = setup();
    const longRationale = 'あ'.repeat(250);
    input.trialDetails = [{ candidateId: 'candidate-1', note: null, formula: input.formula,
      before: measurement(['901']), after: measurement([]),
      impact: { lostHits: 1, gainedHits: 0, inspected: [], error: null },
      reason: '局面の指標に改善がありません', rationale: longRationale }];
    await optimizeQuery(input, provider);
    const prompt = chat.mock.calls[0]![0][1].content as string;
    const section = prompt.split('要求した試行の詳細（')[1]!.split('\n過去の run の却下記録')[0]!;
    expect(section).toContain('candidate-1');
    expect(section).toContain('drug$[tiab]');
    expect(section).toContain('局面の指標に改善がありません');
    // 詳細節は要約と違い rationale を切り詰めない（切り詰めは TRIALS 要約だけの制約）。
    expect(section).toContain(longRationale);
    expect(section).toContain('"lostHits": 1');
  });

  test('取り出せなかった試行は理由だけを渡す', async () => {
    const { input, provider, chat } = setup();
    input.trialDetails = [{ candidateId: 'unknown-id', note: 'この run に候補 ID unknown-id の試行が見つかりません' }];
    await optimizeQuery(input, provider);
    const prompt = chat.mock.calls[0]![0][1].content as string;
    const section = prompt.split('要求した試行の詳細（')[1]!.split('\n過去の run の却下記録')[0]!;
    expect(section).toContain('unknown-id');
    expect(section).toContain('見つかりません');
  });
});
