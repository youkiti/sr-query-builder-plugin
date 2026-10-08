import type { LLMProvider, ToolCall, ToolChatMessage, ToolDefinition } from '../../../lib/llm/LLMProvider';
import { renderPromptTemplate } from '../skills/renderPromptTemplate';
import { AGENT_DRAFT_PROCEDURE, AGENT_DRAFT_SETTINGS } from './procedure';
import { AGENT_COMMANDS, createAgentDraftTools, type AgentCommand, type AgentDraftApproval,
  type AgentDraftDeps, type AgentDraftLimits, type AgentSubmission } from './tools';

export interface AgentDraftStep {
  order: number;
  type: 'write_formula' | 'tool' | 'unknown';
  command: AgentCommand | null;
  exitCode: number | null;
  modelCalls: number;
  measurements: number;
  submissions: number;
}
export interface RunAgentDraftInput extends AgentDraftLimits {
  provider: LLMProvider;
  protocol: { researchQuestion: string; inclusionCriteria: string; exclusionCriteria: string; studyDesign: string };
  blocks: readonly { id: string; name: string; description: string }[];
  filters: AgentDraftApproval['filters'];
  combinationExpression: string;
  deps: AgentDraftDeps;
  signal?: AbortSignal;
  onStep?: (step: AgentDraftStep) => void;
  maxModelCalls?: number;
}
export interface AgentDraftResult {
  status: 'completed' | 'max_turns';
  submission: AgentSubmission | null;
  finalReport: string;
  note?: string;
  modelCalls: number;
  measurements: number;
  submissions: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: AgentDraftStep[];
}

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { name: 'write_formula', description: '検索式の全文を書く', inputSchema: {
    type: 'object', properties: { content: { type: 'string' } }, required: ['content'],
  } },
  { name: 'tool', description: '手順書の道具を呼ぶ', inputSchema: {
    type: 'object', properties: { command: { type: 'string', enum: AGENT_COMMANDS }, argument: { type: 'string' } },
    required: ['command'],
  } },
];

export async function runAgentDraft(input: RunAgentDraftInput): Promise<AgentDraftResult> {
  if (!input.provider.chatWithTools) throw new Error('このプロバイダは道具呼び出し（chatWithTools）に対応していません');
  const tools = createAgentDraftTools({ blockIds: input.blocks.map((block) => block.id),
    filters: input.filters, combinationExpression: input.combinationExpression }, input.deps, input);
  const system = renderPromptTemplate(AGENT_DRAFT_PROCEDURE, {
    MAX_MEASUREMENTS: String(tools.maxMeasurements), MAX_SUBMISSIONS: String(tools.maxSubmissions),
  }) + '\n\n' + AGENT_DRAFT_SETTINGS;
  const messages: ToolChatMessage[] = [{ role: 'user', content: initialMessage(input) }];
  const result: AgentDraftResult = { status: 'max_turns', submission: null, finalReport: '', modelCalls: 0,
    measurements: 0, submissions: 0, tokensIn: 0, tokensOut: 0, toolCalls: [] };
  let empty = false;
  for (let turn = 1; turn <= (input.maxModelCalls ?? 60); turn++) {
    if (input.signal?.aborted) throw input.signal.reason;
    const reply = await input.provider.chatWithTools(system, messages, TOOL_DEFINITIONS, { signal: input.signal });
    if (input.signal?.aborted) throw input.signal.reason;
    result.modelCalls = turn;
    result.tokensIn += reply.tokensIn ?? 0;
    result.tokensOut += reply.tokensOut ?? 0;
    const call = reply.toolCalls[0];
    if (call) {
      const args = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
      let output = await callFunction(call, args, tools);
      if (input.signal?.aborted) throw input.signal.reason;
      const step: AgentDraftStep = {
        order: result.toolCalls.length + 1,
        type: call.name === 'write_formula' || call.name === 'tool' ? call.name : 'unknown',
        command: call.name === 'tool' && AGENT_COMMANDS.includes(args.command as AgentCommand) ? args.command as AgentCommand : null,
        exitCode: output.match(/\[終了コード (\d+)\]$/)?.[1] !== undefined
          ? Number(output.match(/\[終了コード (\d+)\]$/)![1]) : null,
        modelCalls: turn, measurements: tools.state.measurements, submissions: tools.state.submissions,
      };
      result.toolCalls.push(step);
      input.onStep?.({ ...step });
      if (reply.toolCalls.length > 1) output += '\n複数の関数が指定されたため、最初の 1 つだけ実行しました。';
      messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: reply.toolCalls.map((item, index) => ({
        type: 'tool_result', tool_use_id: item.id,
        content: index === 0 ? output : '未実行: 関数は 1 回の応答で 1 つずつ呼んでください。',
      })) });
      empty = false;
    } else if (reply.text) {
      result.finalReport = reply.text;
      result.status = 'completed';
      break;
    } else if (empty) {
      result.status = 'completed';
      result.note = '応答が 2 回続けて空でした';
      break;
    } else {
      empty = true;
      messages.push({ role: 'user', content: '応答が空でした。続けてください。' });
    }
  }
  return { ...result, submission: tools.state.acceptedSubmission,
    measurements: tools.state.measurements, submissions: tools.state.submissions };
}

async function callFunction(call: ToolCall, args: Record<string, unknown>, tools: ReturnType<typeof createAgentDraftTools>): Promise<string> {
  if (call.name === 'write_formula') {
    return typeof args.content === 'string' ? tools.writeFormula(args.content) : 'エラー: content は文字列で指定してください';
  }
  if (call.name !== 'tool') return 'エラー: 未知の関数です';
  if (!AGENT_COMMANDS.includes(args.command as AgentCommand)) return 'エラー: この版では使えないコマンドです';
  if (args.command === 'mesh' && typeof args.argument !== 'string') return 'エラー: argument は文字列で指定してください';
  return tools.call(args.command as AgentCommand, typeof args.argument === 'string' ? args.argument : undefined);
}

function initialMessage(input: RunAgentDraftInput): string {
  const value = (text: string): string => text.trim() || '（記載なし）';
  return [
    '次の研究プロトコルと承認済みの概念ブロックについて、手順書に従って検索式を作り、提出してください。', '',
    '## 研究プロトコル', '',
    `研究疑問: ${value(input.protocol.researchQuestion)}`, `研究デザイン: ${value(input.protocol.studyDesign)}`, '',
    '組入基準:', value(input.protocol.inclusionCriteria), '', '除外基準:', value(input.protocol.exclusionCriteria), '',
    '## 承認済みの概念ブロック', '',
    ...input.blocks.map((block) => `#${block.id} ${value(block.name)}: ${value(block.description)}`), '',
    '## 承認済みのフィルタ（道具が足します。あなたは書きません）', '',
    ...(input.filters.length ? input.filters.map((filter) => `#${filter.blockId} ${filter.expression}`) : ['なし']), '',
    '## 承認済みの結合式（道具が足します。あなたは書きません）', '', value(input.combinationExpression),
  ].join('\n');
}
