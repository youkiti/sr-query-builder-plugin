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
 *
 * ## 人工レイテンシ（収録用）
 *
 * モックはすべて in-memory で即答するため、そのままだと `#/draft` の
 * 「生成して検証する」が 1 秒未満で終わってしまい、進捗トラッカーも
 * ブロックごとのヒット数のライブ表示も画面に映らないまま静止画になる
 * （video/REQUIREMENTS.md §4 の第 7 章が成立しない）。
 *
 * そこで応答前に実 API 相当の待ちを挟む。倍率は `?demoLatency=<係数>` で
 * 調整でき、`0` で無効化できる。**既定は 0（無効）**で、`installDemoFetch()` の
 * 呼び出し元が `setDemoLatencyFactor(resolveDemoLatencyFactor(search))` を
 * 明示的に呼んだときだけ有効になる。jest から `demoFetch` を直接叩くテストを
 * 遅くしないための既定値なので、逆にしないこと。
 */

import { handleEutilsRequest } from './eutilsMock';
import { jsonResponse } from './fakeResponse';
import { handleGeminiGenerateContent } from './llmFixtures';
import { handleDriveRequest, handleSheetsRequest } from './sheetStore';

/** 実 API 相当の待ち時間（ミリ秒）。`latencyFactor` を掛けて使う。 */
const LATENCY_MS = {
  /** LLM 呼び出し。生成 1 回あたり実測で 1〜3 秒かかるが、収録尺の都合で短めに取る */
  llm: 600,
  /** NCBI E-utilities（esearch / efetch） */
  eutils: 250,
  /** Google Sheets / Drive の読み書き */
  google: 80,
} as const;

let latencyFactor = 0;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * `?demoLatency=<係数>` を解釈する。未指定なら等倍（1）、`0` で無効化。
 * 数値として読めない値・負値は等倍にフォールバックする。
 */
export function resolveDemoLatencyFactor(search: string): number {
  const raw = new URLSearchParams(search).get('demoLatency');
  if (raw === null || raw === '') return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

/** 人工レイテンシの倍率を設定する。デモの各エントリが起動時に 1 回だけ呼ぶ。 */
export function setDemoLatencyFactor(factor: number): void {
  latencyFactor = Number.isFinite(factor) && factor > 0 ? factor : 0;
}

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
    await sleep(LATENCY_MS.eutils * latencyFactor);
    return handleEutilsRequest(url);
  }
  if (url.startsWith('https://id.nlm.nih.gov/mesh/sparql')) {
    // MeSH ツリー UI（#58）接続時に本実装へ差し替えるプレースホルダ。現状 UI からは呼ばれない。
    // 専用の LATENCY_MS キーが無いため NCBI E-utilities 相当のレイテンシを流用する。
    await sleep(LATENCY_MS.eutils * latencyFactor);
    return jsonResponse({ head: { vars: [] }, results: { bindings: [] } });
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
    await sleep(LATENCY_MS.llm * latencyFactor);
    return handleGeminiGenerateContent(init ?? {});
  }
  if (url.startsWith('https://openrouter.ai/api/v1/chat/completions')) {
    throw new Error(
      '[demo] デモビルドは OpenRouter 経由の LLM プロバイダに対応していません。Options 画面で Gemini モデルを選択してください。'
    );
  }
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets')) {
    await sleep(LATENCY_MS.google * latencyFactor);
    return handleSheetsRequest(url, method, bodyText);
  }
  if (
    url.startsWith('https://www.googleapis.com/upload/drive/v3/files') ||
    url.startsWith('https://www.googleapis.com/drive/v3/files')
  ) {
    await sleep(LATENCY_MS.google * latencyFactor);
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
