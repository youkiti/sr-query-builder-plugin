import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const COMMANDS = ['check', 'count', 'mesh', 'titles', 'outside', 'submit', 'seeds'] as const;
export type Command = typeof COMMANDS[number];
export interface Conditions {
  version: string; model: string; generationSettings: string; inputs: string[]; tools: Command[];
  maxMeasurements: number; maxSubmissions: number; costLimit: string; finalSelection: string;
  combine?: { from: string; k: number; blocks?: { minOverlap: number; minMargin: number; maxConcepts: number } } | { versions: string[] };
  runner?: 'claude-subagent' | 'gemini-api' | 'openrouter-api';
  provider?: string;
  thinkingLevel?: 'low' | 'medium' | 'high';
  seeds?: { label: string; max: number };
  table?: boolean;
  hitsLimit?: number;
}

export function validateConditions(value: unknown, version: string): Conditions {
  const c = value as Conditions | null;
  if (!/^[A-Za-z0-9_-]+$/.test(version) || !c || c.version !== version) throw new Error('版とフォルダ名が一致しません');
  if (c.runner !== undefined && c.runner !== 'claude-subagent' && c.runner !== 'gemini-api' && c.runner !== 'openrouter-api') throw new Error('実行役の指定が不正です');
  const modelPattern = c.runner === 'openrouter-api' ? /^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/ : /^[A-Za-z0-9.-]+$/;
  if (typeof c.model !== 'string' || !modelPattern.test(c.model) || c.model.includes('latest')) throw new Error('モデルは固定 ID が必要です');
  if (c.runner === 'openrouter-api' ? typeof c.provider !== 'string' || !/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)?$/.test(c.provider)
    : c.provider !== undefined) throw new Error('提供元の指定が不正です');
  if (c.thinkingLevel !== undefined && (!['low', 'medium', 'high'].includes(c.thinkingLevel) || (c.runner !== 'gemini-api' && c.runner !== 'openrouter-api'))) throw new Error('推論の強さの指定が不正です');
  if (c.hitsLimit !== undefined && (!Number.isSafeInteger(c.hitsLimit) || c.hitsLimit < 1 || c.table !== true)) throw new Error('件数の目安の条件が不正です');
  if ((c.table !== undefined && typeof c.table !== 'boolean') || (c.table === true
    && (c.seeds !== undefined || !Array.isArray(c.tools) || c.tools.some((tool) => !['check', 'count', 'mesh', 'submit'].includes(tool))))) throw new Error('表の条件が不正です');
  if (c.seeds !== undefined && (!c.seeds || typeof c.seeds.label !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c.seeds.label)
    || !Number.isInteger(c.seeds.max) || c.seeds.max < 1 || c.seeds.max > 5)) throw new Error('シードの条件が不正です');
  if (!Array.isArray(c.tools) || !c.tools.includes('submit') || c.tools.some((tool) => !COMMANDS.includes(tool))) throw new Error('道具の指定が不正です');
  if (![c.maxMeasurements, c.maxSubmissions].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('上限は正の整数が必要です');
  if (!Array.isArray(c.inputs) || c.inputs.some((s) => typeof s !== 'string')
    || [c.generationSettings, c.costLimit, c.finalSelection].some((s) => typeof s !== 'string' || !s.trim())) throw new Error('生成条件の記述が不正です');
  if (c.combine !== undefined) {
    const combine = c.combine;
    if (!combine || typeof combine !== 'object') throw new Error('束ねる条件の元の版または本数が不正です');
    if ('versions' in combine) {
      if ('from' in combine || 'k' in combine || 'blocks' in combine || !Array.isArray(combine.versions)
        || combine.versions.length < 2 || combine.versions.length > 10
        || combine.versions.some((source) => typeof source !== 'string' || !/^[A-Za-z0-9_-]+$/.test(source) || source === version)
        || new Set(combine.versions).size !== combine.versions.length) throw new Error('束ねる条件の元の版または本数が不正です');
    } else if (!('from' in combine) || typeof combine.from !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(combine.from) || combine.from === version
      || !Number.isInteger(combine.k) || combine.k < 2 || combine.k > 10) throw new Error('束ねる条件の元の版または本数が不正です');
    if ('blocks' in combine) {
      const blocks = combine.blocks;
      if (!blocks || typeof blocks !== 'object'
        || ![blocks.minOverlap, blocks.minMargin].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
        || !Number.isInteger(blocks.maxConcepts) || blocks.maxConcepts < 1 || blocks.maxConcepts > 4) {
        throw new Error('束ねる条件の元の版または本数が不正です');
      }
    }
  }
  return c;
}

export function loadConditions(version: string, harnessDir = resolve(__dirname, '../harness')): Conditions {
  if (!/^[A-Za-z0-9_-]+$/.test(version)) throw new Error('版の形式が不正です');
  return validateConditions(JSON.parse(readFileSync(join(harnessDir, version, 'conditions.json'), 'utf8')), version);
}
