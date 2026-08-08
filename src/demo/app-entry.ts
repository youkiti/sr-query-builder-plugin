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
 *
 * **レイテンシは seed の投入が終わってから効かせる。** `applyDemoSeed()` は
 * プリセットを Sheets/Drive モックへ書き込むのに何十回も `demoFetch` を通るため、
 * 先に倍率を立てると章の冒頭に「画面が出るまでの無音の待ち」が生まれる
 * （実測: 第 7 章で 14.9 秒、第 4 章で 13.9 秒）。seed の投入は演出の対象ではなく
 * 収録前の準備なので、待たせるのは起動後に走る操作だけでよい。
 */

import { createLocationOptions, startApp } from '@/app/bootstrap';
import { createStore, INITIAL_STATE } from '@/app/store';
import { installDemoFetch, resolveDemoLatencyFactor, setDemoLatencyFactor } from './fetchMock';
import { installDemoIdentity } from './identity';
import { applyDemoSeed } from './seeds';

installDemoIdentity();
installDemoFetch();

async function boot(): Promise<void> {
  const search = window.location.search;
  const demoSeed = new URLSearchParams(search).get('demoSeed');
  // seed 投入はレイテンシ 0（既定）のまま一気に流す
  const preloaded = demoSeed ? await applyDemoSeed(demoSeed) : undefined;
  // ここから先（ユーザー操作に伴う fetch）だけを遅くする
  setDemoLatencyFactor(resolveDemoLatencyFactor(search));
  const store = createStore({ ...INITIAL_STATE, ...preloaded });
  startApp(document, { ...createLocationOptions(window), store });
}

void boot();
