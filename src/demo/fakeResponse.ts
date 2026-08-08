/**
 * `fetch` の戻り値として使う最小限の `Response` 互換オブジェクト。
 *
 * ブラウザ本体（unpacked 読み込みした実拡張）では素通しでも問題ないが、
 * `new Response(...)` は jsdom（jest の testEnvironment）にグローバル実装が無く
 * テストで落ちる。本体コードは `res.ok` / `res.status` / `res.json()` / `res.text()` しか
 * 見ないダックタイピングなので（`src/lib/google/types.ts` の `googleFetch` 等参照）、
 * 実 Response を作らずプレーンオブジェクトで代用する
 * （`src/lib/llm/GeminiProvider.test.ts` 等、本体テストと同じ流儀）。
 */
export function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}

export function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      throw new Error('[demo] fakeResponse: このレスポンスは JSON ではありません');
    },
    text: async () => body,
  } as Response;
}
