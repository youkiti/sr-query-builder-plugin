import { parsePubmedFormulaMd, serializePubmedFormulaMd } from '../../../lib/search-formula-md';
import { normalizeCombinationExpression } from '../../../lib/combination-expression';
import type { MeshResolution, MeshTreeLookup } from '../../../lib/ncbi/mesh';
import { isQueryRejection } from '../../../lib/ncbi/queryRejection';
import { expandFormula } from '../../validation/expandFormula';
import { validateFormulaMd } from '../../validation/validateFormulaMd';

export const AGENT_COMMANDS = ['check', 'count', 'mesh', 'submit'] as const;
export type AgentCommand = typeof AGENT_COMMANDS[number];
export interface AgentDraftDeps {
  count(query: string): Promise<number>;
  resolveMesh(term: string): Promise<Map<string, MeshResolution>>;
  meshTrees(headings: readonly string[]): Promise<MeshTreeLookup>;
}
export interface AgentDraftApproval {
  blockIds: readonly string[];
  filters: readonly { blockId: string; expression: string }[];
  combinationExpression: string;
}
export interface AgentDraftLimits { maxMeasurements?: number; maxSubmissions?: number }
export interface AgentSubmission { number: number; md: string; query: string }
export interface AgentDraftState {
  formula: string | null;
  measurements: number;
  submissions: number;
  acceptedSubmission: AgentSubmission | null;
}

export function createAgentDraftTools(approval: AgentDraftApproval, deps: AgentDraftDeps, limits: AgentDraftLimits = {}) {
  const maxMeasurements = limits.maxMeasurements ?? 20;
  const maxSubmissions = limits.maxSubmissions ?? 4;
  const state: AgentDraftState = { formula: null, measurements: 0, submissions: 0, acceptedSubmission: null };
  const finish = (message: string, code: number): string => `${message}\n[終了コード ${code}]`;
  const inspect = () => {
    try {
      const parsed = parsePubmedFormulaMd(state.formula!);
      const reasons: string[] = [];
      for (const id of approval.blockIds) {
        if (!parsed.blocks.some((block) => block.id === id)) reasons.push(`#${id}: 承認済みのブロックの行がありません`);
      }
      for (const block of parsed.blocks) {
        if (!approval.blockIds.includes(block.id)) reasons.push(`#${block.id}: 承認済みのブロックではありません`);
        if (/#/.test(block.expression)) reasons.push(`#${block.id}: 行の中で他の行を参照できません`);
      }
      if (reasons.length) return { ok: false as const, reasons };
      const combinationExpression = normalizeCombinationExpression(approval.combinationExpression);
      const md = serializePubmedFormulaMd({
        blocks: [
          ...approval.blockIds.map((id) => parsed.blocks.find((block) => block.id === id)!),
          ...approval.filters.map(({ blockId, expression }) => ({ id: blockId, expression, isCombination: false })),
          { id: String(approval.blockIds.length + 1), expression: combinationExpression, isCombination: true },
        ], combinationExpression,
      });
      return { ...validateFormulaMd(md), md };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicate = message.match(/^ブロック ID が重複しています: #([A-Za-z0-9]+)$/);
      return { ok: false as const, reasons: [duplicate ? `#${duplicate[1]}: 行が重複しています` : String(error)] };
    }
  };
  return {
    state, maxMeasurements, maxSubmissions,
    writeFormula(content: string): string {
      state.formula = content;
      return `formula.md を書きました（${content.length} 文字）`;
    },
    async call(command: string, argument?: string): Promise<string> {
      if (!AGENT_COMMANDS.includes(command as AgentCommand)) return finish('この版では使えないコマンドです', 2);
      if (command !== 'mesh' && state.formula === null) return '先に write_formula で formula.md を書いてください';
      if ((['count', 'mesh'].includes(command) && state.measurements >= maxMeasurements)
        || (command === 'submit' && state.submissions >= maxSubmissions)) return finish('呼び出し回数の上限に達しています', 2);
      const validated = command === 'mesh' ? undefined : inspect();
      if (validated && !validated.ok) {
        if (command === 'submit') state.submissions++;
        return finish(validated.reasons.join('\n'), 1);
      }
      if (command === 'check') return finish('検査に通りました', 0);
      if (command === 'submit' && validated?.ok) {
        const number = ++state.submissions;
        state.acceptedSubmission = { number, md: validated.md, query: validated.query };
        return finish(`提出 ${number} を受け付けました`, 0);
      }
      try {
        let message: string;
        if (command === 'mesh') {
          if (!argument?.trim()) throw new Error('MeSH の語を 1 つ指定してください');
          const term = argument.trim();
          const resolution = (await deps.resolveMesh(term)).get(term);
          if (!resolution || resolution.status === 'unknown') throw new Error('MeSH の結果が不明です');
          if (resolution.status === 'missing') message = '見出しは見つかりませんでした';
          else {
            const lookup = await deps.meshTrees(resolution.headings);
            message = resolution.headings.map((heading) => `正式な見出し: ${heading}\ntree number: ${lookup.trees.get(heading)?.join(', ') ?? lookup.reasons.get(heading) ?? 'なし'}`).join('\n');
          }
        } else if (validated?.ok && command === 'count') {
          const lines = [`全体: ${await deps.count(validated.query)} 件`];
          for (const block of validated.formula.blocks) lines.push(`#${block.id}: ${await deps.count(expandFormula(validated.formula, block.id))} 件`);
          message = lines.join('\n');
        } else throw new Error('コマンドの引数が不正です');
        state.measurements++;
        return finish(message, 0);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const message = safeErrorMessage(error);
        if (command === 'count' && isQueryRejection(error)) return finish(message, 1);
        return finish(`測定に失敗しました。回数は消費していません${message ? `\n${message}` : ''}`, 3);
      }
    },
  };
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '';
  // URL や認証情報を含みうる例外は本文をモデルへ戻さない。
  return /(?:https?:|www\.|api[_ -]?key|authorization|bearer|sk-)/i.test(error.message) ? '' : error.message;
}
