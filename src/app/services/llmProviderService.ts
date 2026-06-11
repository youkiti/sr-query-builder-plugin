import type { LlmApiLogEntry, LlmPurpose } from '@/domain/llmApiLog';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import type { ProjectStoreDeps } from '@/features/project';
import {
  appendRow,
  uploadTextFile,
  type GoogleApiDeps,
} from '@/lib/google';
import {
  GeminiProvider,
  withLogging,
  type LLMProvider,
} from '@/lib/llm';

/**
 * LLM プロバイダ生成サービス。
 *
 * - chrome.storage から Gemini API キーを取得
 * - GeminiProvider を生成
 * - withLogging で Drive へ prompt/response を保存し、LLMApiLog に行追記
 *
 * skill は呼び出すたびに purpose が変わるため、`LlmProviderFactory.forPurpose(purpose)`
 * の形で提供する（LLMProvider 自体は purpose を持たないという §4.9 の方針に従う）。
 */

export const STORAGE_KEY_GEMINI = 'apiKeys.gemini';
const LLM_LOG_HEADER = SHEET_HEADERS.LLMApiLog;

export class LlmApiKeyMissingError extends Error {
  constructor() {
    super(
      'Gemini API キーが未設定です。Options 画面（chrome://extensions の拡張詳細 → 拡張機能のオプション）で設定してください。'
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
  /** 任意: GeminiProvider のモデル指定 */
  model?: string;
  /** 任意: LLM 呼び出しごとに概算コストを通知するコールバック（§ cumulativeCostUsd 集計用）。 */
  onCostAccumulate?: (costUsd: number) => void;
}

export interface LlmProviderFactory {
  /** 指定 purpose 用のロガー付きプロバイダを返す */
  forPurpose: (purpose: LlmPurpose) => LLMProvider;
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
 * Drive ロガー付きの LLMProvider ファクトリを生成する。
 * @throws {LlmApiKeyMissingError} chrome.storage に Gemini API キーが無いとき
 */
export async function buildLlmProviderFactory(deps: LlmFactoryDeps): Promise<LlmProviderFactory> {
  const apiKey = await getGeminiApiKey(deps.store);
  if (apiKey === null) {
    throw new LlmApiKeyMissingError();
  }
  const baseProvider = new GeminiProvider({
    apiKey,
    model: deps.model,
    fetch: deps.google.fetch,
  });
  return {
    forPurpose: (purpose) =>
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
      }),
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
