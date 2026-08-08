/**
 * デモビルド専用の `options.html` エントリ。
 *
 * Options 画面自体は `chrome.storage.local` の読み書きのみで完結し
 * identity / fetch は使わないが、他 2 エントリ（app / popup）と方針を揃え、
 * 将来 Options がモデル一覧取得等でネットワークに触れても安全なように
 * 同じモックを差し込んでおく。
 */

import { createChromeOptionsDeps, startOptions } from '@/options/bootstrap';
import { installDemoFetch } from './fetchMock';
import { installDemoIdentity } from './identity';

installDemoIdentity();
installDemoFetch();

void startOptions(document, createChromeOptionsDeps());
