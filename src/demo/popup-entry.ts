/**
 * デモビルド専用の `popup.html` エントリ。
 * `chrome.identity` / `globalThis.fetch` をモックへ差し替えてから、
 * 本物の起動ロジック（`src/popup/popup.ts` と同一）を呼ぶ。
 *
 * `?demoLatency=<係数>` の扱いは app エントリと同じ。プロジェクト作成が
 * 一瞬で終わると「作成中...」のフィードバックが映らないため、収録では
 * レイテンシを効かせる。
 */

import { createChromePopupDeps, startPopup } from '@/popup/bootstrap';
import { installDemoFetch, resolveDemoLatencyFactor, setDemoLatencyFactor } from './fetchMock';
import { installDemoIdentity } from './identity';

installDemoIdentity();
installDemoFetch();
setDemoLatencyFactor(resolveDemoLatencyFactor(window.location.search));

void startPopup(document, createChromePopupDeps());
