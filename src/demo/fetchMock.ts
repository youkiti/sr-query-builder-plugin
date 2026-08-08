/**
 * `globalThis.fetch` の差し替え本体。
 *
 * `src/app/services/factories.ts` の `createChromeGoogleApiDeps()` は
 * `fetch: (input, init) => globalThis.fetch(input, init)` を渡しており、NCBI
 * （`src/app/services/ncbiConfigService.ts`）・LLM（`src/lib/llm/providerFactory.ts`）も
 * 同じ `deps.google.fetch` を経由するため、`globalThis.fetch` を 1 枚差し替えるだけで
 * Google Sheets/Drive・Gemini・NCBI E-utilities のすべてを捕まえられる
 * （video/REQUIREMENTS.md ブリーフの「DI の継ぎ目」）。
 *
 * ここに挙げた 6 エンドポイント以外への fetch は明示的にエラーを投げる。
 * 気づかないまま実ネットワークに出るのを防ぐため。
 */

import { handleEutilsRequest } from './eutilsMock';
import { handleGeminiGenerateContent } from './llmFixtures';
import { handleDriveRequest, handleSheetsRequest } from './sheetStore';

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * デモビルド用の `fetch` 実装。既存の `globalThis.fetch` を直接この関数で
 * 上書きする（`installDemoFetch()`）。
 */
export async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = resolveUrl(input);
  const method = init?.method ?? 'GET';
  const bodyText = typeof init?.body === 'string' ? init.body : '';

  if (url.startsWith('https://eutils.ncbi.nlm.nih.gov/entrez/eutils')) {
    return handleEutilsRequest(url);
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
    return handleGeminiGenerateContent(init ?? {});
  }
  if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
    throw new Error(
      '[demo] デモビルドは OpenRouter 経由の LLM プロバイダに対応していません。Options 画面で Gemini モデルを選択してください。'
    );
  }
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets')) {
    return handleSheetsRequest(url, method, bodyText);
  }
  if (
    url.startsWith('https://www.googleapis.com/upload/drive/v3/files') ||
    url.startsWith('https://www.googleapis.com/drive/v3/files')
  ) {
    const headers = new Headers(init?.headers);
    return handleDriveRequest(url, method, bodyText, headers.get('Content-Type') ?? '');
  }
  throw new Error(
    `[demo] fetchMock: 未対応の fetch 先です（デモビルドはネットワークに出ません）: ${method} ${url}`
  );
}

/** `globalThis.fetch` を `demoFetch` に差し替える。デモの各エントリの先頭で 1 回だけ呼ぶ。 */
export function installDemoFetch(): void {
  globalThis.fetch = demoFetch as unknown as typeof fetch;
}
