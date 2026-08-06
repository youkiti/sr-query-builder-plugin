import type { LlmApiLogEntry, LlmPurpose } from '@/domain/llmApiLog';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { ProjectStoreDeps } from '@/features/project';
import {
  appendRow,
  uploadTextFile,
  type GoogleApiDeps,
} from '@/lib/google';
import {
  createProvider,
  resolveProviderId,
  DEFAULT_MODEL,
  withLogging,
  withRetry,
  type LLMProvider,
} from '@/lib/llm';

/**
 * LLM プロバイダ生成サービス。
 *
 * - chrome.storage から Gemini API キーを取得
 * - GeminiProvider を生成
 * - withLogging で Drive へ prompt/response を保存し、LLMApiLog に行追記
 * - withRetry で 429/5xx の一時的エラーを指数バックオフで自動再試行
 *
 * skill は呼び出すたびに purpose が変わるため、`LlmProviderFactory.forPurpose(purpose)`
 * の形で提供する（LLMProvider 自体は purpose を持たないという §4.9 の方針に従う）。
 */

export const STORAGE_KEY_GEMINI = 'apiKeys.gemini';
export const STORAGE_KEY_OPENROUTER = 'apiKeys.openrouter';
export const STORAGE_KEY_LLM_MODEL = 'llm.selectedModel';
const LLM_LOG_HEADER = SHEET_HEADERS.LLMApiLog;

export class LlmApiKeyMissingError extends Error {
  constructor(provider: string = 'Gemini') {
    super(
      provider +
        ' API キーが未設定です。Options 画面（chrome://extensions の拡張詳細 → 拡張機能のオプション）で設定してください。'
    );
    this.name = 'LlmApiKeyMissingError';
  }
}

export interface LlmFactoryDeps {
  google: GoogleApiDeps;
  store: ProjectStoreDeps;
  /** ログ JSON を置く Drive フォルダ ID（通常は logs/llm/ 配下）。 */
  llmLogFolderId: string;
  /** LLMApiLog 行を追記する spreadsheet。 */
  spreadsheetId: string;
  /** 任意: モデル指定の上書き（主にテスト用。通常は chrome.storage の選択モデルを使う）。 */
  model?: string;
  /** 任意: LLM 呼び出しごとに概算コストを通知するコールバック（§ cumulativeCostUsd 集計用）。 */
  onCostAccumulate?: (costUsd: number) => void;
}

export interface LlmProviderFactory {
  /** 指定 purpose 用のロガー付きプロバイダを返す */
  forPurpose: (purpose: LlmPurpose) => LLMProvider;
  /** このファクトリが解決したモデル ID（FormulaVersions.model への記録用） */
  model: string;
}

/**
 * chrome.storage から Gemini API キーを取得する（無ければ null）。
 */
export async function getGeminiApiKey(store: ProjectStoreDeps): Promise<string | null> {
  const value = await store.read<string>(STORAGE_KEY_GEMINI);
  if (value === undefined || value === '') {
    return null;
  }
  return value;
}

/**
 * chrome.storage から OpenRouter API キーを取得する（無ければ null）。
 */
export async function getOpenRouterApiKey(store: ProjectStoreDeps): Promise<string | null> {
  const value = await store.read<string>(STORAGE_KEY_OPENROUTER);
  return value === undefined || value === '' ? null : value;
}

/**
 * Drive ロガー付きの LLMProvider ファクトリを生成する。
 *
 * 選択モデル（`deps.model` の上書き → chrome.storage → `DEFAULT_MODEL`）から
 * プロバイダを解決し、対応する API キーを取得して `createProvider` で生成する。
 * @throws {LlmApiKeyMissingError} 解決したプロバイダの API キーが chrome.storage に無いとき
 */
export async function buildLlmProviderFactory(deps: LlmFactoryDeps): Promise<LlmProviderFactory> {
  const selectedModel =
    deps.model ?? (await deps.store.read<string>(STORAGE_KEY_LLM_MODEL)) ?? DEFAULT_MODEL;
  const providerId = resolveProviderId(selectedModel);
  const apiKey =
    providerId === 'openrouter'
      ? await getOpenRouterApiKey(deps.store)
      : await getGeminiApiKey(deps.store);
  if (apiKey === null) {
    const providerName = providerId === 'openrouter' ? 'OpenRouter' : 'Gemini';
    throw new LlmApiKeyMissingError(providerName);
  }
  const baseProvider = createProvider({
    apiKey,
    model: selectedModel,
    fetch: deps.google.fetch,
  });
  // withLogging を内側にして「再試行 1 回ごとに LLMApiLog へ 1 行」残す
  // （503 等の失敗試行も監査ログに見える状態を保つ）。
  return {
    model: selectedModel,
    forPurpose: (purpose) =>
      withRetry(
        withLogging(baseProvider, purpose, {
          uploadJson: async ({ filename, content }) => {
            const file = await uploadTextFile(
              {
                name: filename,
                content,
                parentId: deps.llmLogFolderId,
                mimeType: 'application/json',
              },
              deps.google
            );
            return { webViewLink: file.webViewLink };
          },
          appendLogEntry: async (entry) => {
            await appendRow(deps.spreadsheetId, 'LLMApiLog', toLogRow(entry), deps.google);
            if (entry.costEstimateUsd !== null) {
              deps.onCostAccumulate?.(entry.costEstimateUsd);
            }
          },
        })
      ),
  };
}

function toLogRow(entry: LlmApiLogEntry): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    log_id: entry.logId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    purpose: entry.purpose,
    prompt_ref: entry.promptRef,
    response_ref: entry.responseRef,
    prompt_summary: entry.promptSummary,
    tokens_in: entry.tokensIn,
    tokens_out: entry.tokensOut,
    latency_ms: entry.latencyMs,
    cost_estimate_usd: entry.costEstimateUsd,
    error: entry.error,
  };
  return LLM_LOG_HEADER.map((key) => map[key] ?? null);
}
