/**
 * デモビルド専用の `options.html` エントリ。
 *
 * Options 画面は大半が `chrome.storage.local` の読み書きで完結するが、
 * Gemini のプラン判定（`detectGeminiTier`）だけは `globalThis.fetch` で
 * `generateContent` を叩くため、fetch モックが要る。identity は他 2 エントリ
 * （app / popup）と方針を揃えて差し込んでおく。
 */

import { createChromeOptionsDeps, startOptions } from '@/options/bootstrap';
import { installDemoFetch, resolveDemoLatencyFactor, setDemoLatencyFactor } from './fetchMock';
import { installDemoIdentity } from './identity';

installDemoIdentity();
installDemoFetch();
setDemoLatencyFactor(resolveDemoLatencyFactor(window.location.search));

void startOptions(document, createChromeOptionsDeps());
