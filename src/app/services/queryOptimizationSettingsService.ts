import type { ProjectStoreDeps } from '@/features/project';
import { HIT_THRESHOLD } from '@/features/formula/skills/filterDesigner';
import { DEFAULT_MAX_ITERATIONS } from './queryOptimizationService';

const SETTINGS_KEY = 'queryOptimizationSettings';
/** 最近使ったプロジェクト一覧と同じ規模の 10 件に制限する。 */
export const MAX_SAVED_OPTIMIZATION_PROJECTS = 10;

interface SettingsHistory {
  projects: Record<string, ProjectQueryOptimizationSettings>;
  /** 最後に保存した順（古いものが先頭）。読み取りだけでは順番を変えない。 */
  order: string[];
}

export interface QueryOptimizationSettings {
  maxHits: number;
  maxIterations: number;
}

export interface ProjectQueryOptimizationSettings extends QueryOptimizationSettings {
  projectId: string;
}

export const DEFAULT_QUERY_OPTIMIZATION_SETTINGS: Readonly<QueryOptimizationSettings> = {
  maxHits: HIT_THRESHOLD,
  maxIterations: DEFAULT_MAX_ITERATIONS,
};

export function validateQueryOptimizationSettings(settings: QueryOptimizationSettings, seedCount = 0): string | null {
  if (!Number.isSafeInteger(settings.maxHits) || settings.maxHits <= 0) return '最大件数は正の整数で指定してください。';
  if (!Number.isSafeInteger(settings.maxIterations) || settings.maxIterations <= 0) return '反復上限は正の整数で指定してください。';
  if (settings.maxHits < seedCount) return '最大件数が検証対象シード数より少なく、条件を両立できません。';
  return null;
}

/** プロジェクト別の前回値を単一キーに保存し、最終保存が古いものから上限を適用する。 */
export async function saveQueryOptimizationSettings(projectId: string, settings: QueryOptimizationSettings,
  deps: ProjectStoreDeps): Promise<void> {
  const error = validateQueryOptimizationSettings(settings);
  if (error) throw new Error(error);
  const history = readSettingsHistory(await deps.read<unknown>(SETTINGS_KEY));
  const order = [...history.order.filter((id) => id !== projectId), projectId].slice(-MAX_SAVED_OPTIMIZATION_PROJECTS);
  const current: ProjectQueryOptimizationSettings = { projectId, maxHits: settings.maxHits, maxIterations: settings.maxIterations };
  const projects = Object.fromEntries(order.map((id) => [id, id === projectId ? current : history.projects[id]!]));
  await deps.write({ [SETTINGS_KEY]: { projects, order } });
}

export async function getQueryOptimizationSettings(projectId: string,
  deps: ProjectStoreDeps): Promise<ProjectQueryOptimizationSettings | null> {
  const history = readSettingsHistory(await deps.read<unknown>(SETTINGS_KEY));
  return Object.prototype.hasOwnProperty.call(history.projects, projectId) ? history.projects[projectId]! : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProjectSettings(value: unknown, projectId: string): ProjectQueryOptimizationSettings | null {
  if (!isRecord(value) || value.projectId !== projectId
    || typeof value.maxHits !== 'number' || typeof value.maxIterations !== 'number') return null;
  const settings = { projectId, maxHits: value.maxHits, maxIterations: value.maxIterations };
  return validateQueryOptimizationSettings(settings) ? null : settings;
}

/** 旧単一プロジェクト形式も読み、次の保存時に履歴形式へ移す。不正な値は復元しない。 */
function readSettingsHistory(value: unknown): SettingsHistory {
  const empty: SettingsHistory = { projects: {}, order: [] };
  if (!isRecord(value)) return empty;
  if (typeof value.projectId === 'string') {
    const legacy = readProjectSettings(value, value.projectId);
    return legacy ? { projects: Object.fromEntries([[legacy.projectId, legacy]]), order: [legacy.projectId] } : empty;
  }
  if (!isRecord(value.projects) || !Array.isArray(value.order)) return empty;
  const projects = value.projects;
  const entries = new Map<string, ProjectQueryOptimizationSettings>();
  for (const id of value.order) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(projects, id)) continue;
    const settings = readProjectSettings(projects[id], id);
    if (settings) {
      entries.delete(id);
      entries.set(id, settings);
    }
  }
  const bounded = [...entries].slice(-MAX_SAVED_OPTIMIZATION_PROJECTS);
  return { projects: Object.fromEntries(bounded), order: bounded.map(([id]) => id) };
}
