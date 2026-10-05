import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const COMMANDS = ['check', 'count', 'mesh', 'titles', 'submit'] as const;
export type Command = typeof COMMANDS[number];
export interface Conditions {
  version: string; model: string; generationSettings: string; inputs: string[]; tools: Command[];
  maxMeasurements: number; maxSubmissions: number; costLimit: string; finalSelection: string;
}

export function validateConditions(value: unknown, version: string): Conditions {
  const c = value as Conditions | null;
  if (!/^[A-Za-z0-9_-]+$/.test(version) || !c || c.version !== version) throw new Error('版とフォルダ名が一致しません');
  if (typeof c.model !== 'string' || !/^[A-Za-z0-9.-]+-\d{8}$/.test(c.model) || c.model.includes('-latest')) throw new Error('モデルは固定 ID が必要です');
  if (!Array.isArray(c.tools) || !c.tools.includes('submit') || c.tools.some((tool) => !COMMANDS.includes(tool))) throw new Error('道具の指定が不正です');
  if (![c.maxMeasurements, c.maxSubmissions].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('上限は正の整数が必要です');
  if (!Array.isArray(c.inputs) || c.inputs.some((s) => typeof s !== 'string')
    || [c.generationSettings, c.costLimit, c.finalSelection].some((s) => typeof s !== 'string' || !s.trim())) throw new Error('生成条件の記述が不正です');
  return c;
}

export function loadConditions(version: string, harnessDir = resolve(__dirname, '../harness')): Conditions {
  if (!/^[A-Za-z0-9_-]+$/.test(version)) throw new Error('版の形式が不正です');
  return validateConditions(JSON.parse(readFileSync(join(harnessDir, version, 'conditions.json'), 'utf8')), version);
}
