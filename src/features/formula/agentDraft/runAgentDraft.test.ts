import type { LLMProvider, ToolChatResponse, ToolCall, ToolChatMessage } from '../../../lib/llm/LLMProvider';
import { parsePubmedFormulaMd } from '../../../lib/search-formula-md';
import { runAgentDraft, type RunAgentDraftInput } from './runAgentDraft';

const content = '## PubMed/MEDLINE\n\n```\n#1 disease[tiab]\n#2 treatment[tiab]\n```';
const call = (name: string, input: unknown, id = 'toolu_1'): ToolCall => ({ id, name, input });
const reply = (toolCalls: ToolCall[] = [], text = ''): ToolChatResponse => ({
  toolCalls, text, content: [{ type: 'thinking', thinking: '', signature: 'sig' },
    ...toolCalls.map((item) => ({ type: 'tool_use', ...item })), ...(text ? [{ type: 'text', text }] : [])],
  stopReason: toolCalls.length ? 'tool_use' : 'end_turn', tokensIn: 10, tokensOut: 5, raw: {},
});
function setup(replies: ToolChatResponse[]) {
  const requests: { system: string; messages: readonly ToolChatMessage[] }[] = [];
  const chatWithTools = jest.fn<ReturnType<NonNullable<LLMProvider['chatWithTools']>>, Parameters<NonNullable<LLMProvider['chatWithTools']>>>()
    .mockImplementation(async (system, messages) => {
      requests.push({ system, messages: [...messages] });
      const next = replies.shift();
      if (!next) throw new Error('偽応答がありません');
      return next;
    });
  const input: RunAgentDraftInput = {
    provider: { providerId: 'anthropic', model: 'fake', chat: jest.fn(), chatWithTools },
    protocol: { researchQuestion: '疑問', inclusionCriteria: '組入', exclusionCriteria: '', studyDesign: 'RCT' },
    blocks: [{ id: '1', name: '疾患', description: '説明1' }, { id: '2', name: '治療', description: '説明2' }],
    filters: [{ blockId: 'RCTfilter', expression: 'trial[pt]' }], combinationExpression: '#1 AND #2 AND #RCTfilter',
    deps: { count: jest.fn().mockResolvedValue(42), resolveMesh: jest.fn(), meshTrees: jest.fn() }, onStep: jest.fn(),
  };
  return { input, chatWithTools, requests };
}

test('書く・検査・測定・提出・最終報告を偽プロバイダで完了する', async () => {
  const first = reply([call('write_formula', { content })]);
  const { input, requests, chatWithTools } = setup([first,
    ...['check', 'count', 'submit'].map((command) => reply([call('tool', { command })])), reply([], '最終報告')]);
  input.maxMeasurements = 7;
  input.maxSubmissions = 2;
  const result = await runAgentDraft(input);
  expect(result).toMatchObject({ status: 'completed', finalReport: '最終報告', modelCalls: 5,
    measurements: 1, submissions: 1, tokensIn: 50, tokensOut: 25, submission: { number: 1 } });
  const parsed = parsePubmedFormulaMd(result.submission!.md);
  expect(parsed.blocks.map((block) => block.id)).toEqual(['1', '2', 'RCTfilter', '3']);
  expect(parsed.combinationExpression).toBe(input.combinationExpression);
  expect(result.submission!.query).toContain('trial[pt]');
  expect(requests[1]!.messages[1]!.content).toBe(first.content);
  expect(requests[0]!.system).not.toContain('{{');
  expect(requests[0]!.system).toContain('合わせて 7 回まで');
  expect(requests[0]!.system).toContain('`submit` は 2 回まで');
  expect(requests[0]!.messages[0]!.content).toContain('除外基準:\n（記載なし）');
  expect(requests[0]!.messages[0]!.content).toContain('#1 疾患: 説明1');
  expect(requests[0]!.messages[0]!.content).toContain('#RCTfilter trial[pt]');
  expect(chatWithTools.mock.calls[0]![2].map((tool) => tool.name)).toEqual(['write_formula', 'tool']);
  expect(input.onStep).toHaveBeenCalledTimes(4);
  expect(result.toolCalls.map(({ order, type, command, exitCode }) => ({ order, type, command, exitCode }))).toEqual([
    { order: 1, type: 'write_formula', command: null, exitCode: null },
    { order: 2, type: 'tool', command: 'check', exitCode: 0 },
    { order: 3, type: 'tool', command: 'count', exitCode: 0 },
    { order: 4, type: 'tool', command: 'submit', exitCode: 0 },
  ]);
  expect(JSON.stringify(result.toolCalls)).not.toMatch(/disease|疑問|説明1/);
});

test('複数呼び出しは最初だけ実行し、すべての ID に結果を戻す', async () => {
  const first = reply([call('write_formula', { content }, 'a'), call('tool', { command: 'submit' }, 'b')]);
  const { input, requests } = setup([first, reply([], '終了')]);
  const result = await runAgentDraft(input);
  expect(result.submissions).toBe(0);
  expect(result.toolCalls).toHaveLength(1);
  expect(requests[1]!.messages[1]!.content).toEqual(first.content);
  expect(requests[1]!.messages[2]!.content).toEqual([
    { type: 'tool_result', tool_use_id: 'a', content: `formula.md を書きました（${content.length} 文字）\n複数の関数が指定されたため、最初の 1 つだけ実行しました。` },
    { type: 'tool_result', tool_use_id: 'b', content: '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。' },
  ]);
});

test('文章だけなら提出なしでも完了する', async () => {
  const { input } = setup([reply([], '報告')]);
  expect(await runAgentDraft(input)).toMatchObject({ status: 'completed', submission: null, finalReport: '報告', modelCalls: 1 });
});

test('空応答には継続を促し、連続した空応答で完了する', async () => {
  const { input, requests } = setup([reply(), reply()]);
  expect(await runAgentDraft(input)).toMatchObject({ status: 'completed', modelCalls: 2, note: '応答が 2 回続けて空でした' });
  expect(requests[1]!.messages[1]).toEqual({ role: 'user', content: '応答が空でした。続けてください。' });
});

test('道具の呼び出しで空応答の連続をリセットする', async () => {
  const { input } = setup([reply(), reply([call('write_formula', { content })]), reply(), reply([], '報告')]);
  expect(await runAgentDraft(input)).toMatchObject({ status: 'completed', modelCalls: 4, finalReport: '報告' });
});

test.each([1, 60])('呼び出し上限 %i で停止する', async (limit) => {
  const { input, chatWithTools } = setup(Array.from({ length: limit }, () => reply([call('write_formula', { content })])));
  if (limit !== 60) input.maxModelCalls = limit;
  expect(await runAgentDraft(input)).toMatchObject({ status: 'max_turns', modelCalls: limit });
  expect(chatWithTools).toHaveBeenCalledTimes(limit);
});

test.each([
  [call('write_formula', { content: 3 }), 'エラー: content は文字列で指定してください'],
  [call('unknown', {}), 'エラー: 未知の関数です'],
  [call('tool', { command: 'titles' }), 'エラー: この版では使えないコマンドです'],
  [call('tool', { command: 'mesh', argument: 3 }), 'エラー: argument は文字列で指定してください'],
])('不正な関数・引数を結果として戻す', async (toolCall, expected) => {
  const { input, requests } = setup([reply([toolCall]), reply([], '報告')]);
  expect(await runAgentDraft(input)).toMatchObject({ measurements: 0, submissions: 0 });
  expect(requests[1]!.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: expected }]);
});

test('非対応プロバイダと通信例外を呼び出し側へ返す', async () => {
  const { input, chatWithTools } = setup([]);
  const error = new Error('通信失敗');
  chatWithTools.mockRejectedValueOnce(error);
  await expect(runAgentDraft(input)).rejects.toBe(error);
  delete input.provider.chatWithTools;
  await expect(runAgentDraft(input)).rejects.toThrow('chatWithTools');
});

test('中断はそのまま投げる', async () => {
  const { input, chatWithTools } = setup([]);
  const controller = new AbortController();
  const reason = new Error('中止');
  controller.abort(reason);
  input.signal = controller.signal;
  await expect(runAgentDraft(input)).rejects.toBe(reason);
  expect(chatWithTools).not.toHaveBeenCalled();
});

test('フィルタなしを最初のメッセージに明記する', async () => {
  const { input, requests } = setup([reply([], '報告')]);
  input.filters = [];
  input.combinationExpression = '#1 AND #2';
  await runAgentDraft(input);
  expect(requests[0]!.messages[0]!.content).toContain('あなたは書きません）\n\nなし');
});
