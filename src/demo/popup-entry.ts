/**
 * デモビルド専用の `popup.html` エントリ。
 * `chrome.identity` / `globalThis.fetch` をモックへ差し替えてから、
 * 本物の起動ロジック（`src/popup/popup.ts` と同一）を呼ぶ。
 */

import { createChromePopupDeps, startPopup } from '@/popup/bootstrap';
import { installDemoFetch } from './fetchMock';
import { installDemoIdentity } from './identity';

installDemoIdentity();
installDemoFetch();

void startPopup(document, createChromePopupDeps());
