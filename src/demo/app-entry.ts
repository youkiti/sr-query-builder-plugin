/**
 * デモビルド専用の `app.html` エントリ（`webpack --env demo` でのみ使われる）。
 *
 * 本物の起動ロジック（`createLocationOptions` + `startApp`。`src/app/app.ts` と同一）を
 * 呼ぶ前に、`chrome.identity` / `globalThis.fetch` をモックへ差し替え、
 * `?demoSeed=<name>` が付いていれば対応するプリセットを Sheets/Drive の
 * in-memory バックエンドへ書き込んで、その結果を store の初期値として渡す。
 *
 * `src/app/app.ts` が持つ `window.__E2E_PRELOADED_STATE__` フックは使わず、
 * `startApp` の `store` オプションへ直接注入する（このエントリが app.ts を
 * まるごと置き換えるため、グローバル変数越しに渡す必要が無い）。
 *
 * `?demoSeed=` 未指定 / 空文字なら何もせず「まっさら」（プロジェクト未作成）から
 * 始まる（video/REQUIREMENTS.md §6-4）。
 *
 * あわせて `?demoLatency=<係数>` で fetch モックの人工レイテンシ倍率を渡す
 * （未指定なら等倍、`0` で無効化。詳細は `./fetchMock` のヘッダーコメント）。
 */

import { createLocationOptions, startApp } from '@/app/bootstrap';
import { createStore, INITIAL_STATE } from '@/app/store';
import { installDemoFetch, resolveDemoLatencyFactor, setDemoLatencyFactor } from './fetchMock';
import { installDemoIdentity } from './identity';
import { applyDemoSeed } from './seeds';

installDemoIdentity();
installDemoFetch();
setDemoLatencyFactor(resolveDemoLatencyFactor(window.location.search));

async function boot(): Promise<void> {
  const demoSeed = new URLSearchParams(window.location.search).get('demoSeed');
  const preloaded = demoSeed ? await applyDemoSeed(demoSeed) : undefined;
  const store = createStore({ ...INITIAL_STATE, ...preloaded });
  startApp(document, { ...createLocationOptions(window), store });
}

void boot();
