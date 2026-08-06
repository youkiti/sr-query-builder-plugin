/**
 * Chrome ウェブストア / GitHub Pages 掲載用スクリーンショット（s1〜s5）の撮影本体。
 *
 * `tools/selenium/manualCheck.mjs --shots` は実 Chrome + 実 Google/Gemini/NCBI API +
 * コンソールでの手動ログイン待ちが必要で、無人実行できない。本 spec は既存 E2E と同じ
 * stub 環境（tests/e2e/fixtures/appStub.ts）を使い、`window.__E2E_PRELOADED_STATE__` で
 * state を直接流し込むことで、実 API を一切叩かずに 5 枚を撮る。
 *
 * 置き場所を tests/e2e/ ではなく tests/shots/ にしているのは意図的:
 * - tsconfig.json の include（src/**\/* + tests/**\/*）と `npm run lint`（eslint src tests）は
 *   両方効かせたいので tests/ 配下に置く
 * - playwright.config.ts の testDir は tests/e2e のため、既定の `npm run test:e2e` には
 *   収集されない（撮影専用の playwright.shots.config.ts からのみ実行される）
 *
 * draftView.ts の仕様上、生成・検証が完全に完了すると draftRun は null に戻り、
 * ブロックごとのライブヒット数（.draft__block-hits）は非表示になる（検証結果セクションに
 * 引き継がれるため）。そのため s3（ヒット数が見えている状態）と s4（捕捉率・MeSH 検証）は
 * それぞれ別の preloadedState から個別に撮る（fixtures.ts の draftRunningShotState /
 * draftValidatedShotState を参照）。
 *
 * ## フレーミング（スクロール位置）について
 *
 * `.app__sidebar`（左ナビ）は sticky ではなく、ページ全体と一緒にスクロールして消える。
 * さらにナビ項目は 10 個・約 460px 分しかないのに対し、サイドバーの背景自体は
 * `.app__main { display:flex }` の align-items:stretch でコンテンツと同じ高さまで伸びるため、
 * ナビ項目より下（＝スクロール後に真っ先に見える位置）は「意味の無い空白の帯」になりやすい。
 * これを避けるため、単純に `scrollIntoView({block:'start'})` を対象コンテンツへ掛けるのではなく:
 *
 * - スクロール量そのものを最小限にする（対象コンテンツを画面下寄りに置き、サイドバーの
 *   ナビ項目をできるだけ画面内に残す）
 * - どうしてもヘッダー・サイドバーの両方を画面内に残せない場合はサイドバーを優先する
 * - スクロール先の基準点をコンテンツ側のセレクタではなく、**左サイドバーのナビ項目（li）**に
 *   置くことで、ナビ項目が上端で半端に切れる（＝ボタンの上半分だけ見切れる）ことも避ける
 *   （ナビ項目の境界にきっちり合わせてスクロールするため）
 *
 * 各スクロール量は `tests/shots/_debug.spec.ts`（一時的に作成し測定後に削除した計測用 spec）で
 * 実測した座標を基に選んでいる。s3 はさらに、生成中に「既存 formula の全文カード」を
 * 表示しない状態（初回生成中）にすることで縦を大きく圧縮し、スクロール自体を不要にした
 * （fixtures.ts の draftRunningShotState のコメント参照）。s2 も同様に、
 * blocksShotState() 専用の短いプロトコル（SHOTS_PROTOCOL_DRAFT_SHORT）でスクロール自体を
 * 不要にしている（フィールドを短縮しただけでは `.blocks__protocol-ref-body` の
 * max-height:240px を割れず、フィールド数そのものを 5→4 に減らして初めて収まった。詳細は
 * fixtures.ts の SHOTS_PROTOCOL_DRAFT_SHORT のコメント参照）。
 *
 * なお `.blocks__actions`（下書き保存・承認ボタンの行）は `position: sticky; bottom: 0` で
 * 常に画面最下部に張り付くため、スクロール量 0 でもブロックカード #1 の下側（説明欄等）は
 * このバーの下に隠れる。これは実際のアプリの挙動そのもの（撮影上のごまかしではない）で、
 * 「文字が途中で切れる」問題ではないため許容する。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { injectAppStub } from '../e2e/fixtures/appStub';
import {
  protocolShotState,
  blocksShotState,
  draftRunningShotState,
  draftValidatedShotState,
  exportShotState,
  shotsScenario,
} from './fixtures';

const SHOTS_DIR = path.resolve(__dirname, '../../hosted/screenshots');
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

test.beforeAll(() => {
  mkdirSync(SHOTS_DIR, { recursive: true });
});

/**
 * PNG バイナリの幅・高さを IHDR チャンクから読む。
 * tools/selenium/manualCheck.mjs の pngDimensions() と同じ手法（追加依存を増やさないための
 * 自前パーサ。PNG シグネチャ 8 バイトの直後の IHDR チャンクに幅・高さが各 4B で入っている）。
 */
function pngDimensions(buffer: Buffer): { width: number; height: number } {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * 撮影して hosted/screenshots/{name}.png へ保存し、サイズが 1280x800 であることを検証する。
 * scrollSelector を渡すとその要素が先頭に来る位置までスクロールしてから撮る（省略時は先頭に戻す）。
 */
async function takeShot(page: Page, name: string, scrollSelector?: string): Promise<void> {
  if (scrollSelector) {
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      el?.scrollIntoView({ block: 'start' });
    }, scrollSelector);
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  // スクロール直後の描画が落ち着くのを待つ（tools/selenium/manualCheck.mjs の shot() と同じ 200ms）
  await page.waitForTimeout(200);

  const filePath = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filePath });

  const buffer = readFileSync(filePath);
  const { width, height } = pngDimensions(buffer);
  expect(width, `${name}.png の幅`).toBe(VIEWPORT_WIDTH);
  expect(height, `${name}.png の高さ`).toBe(VIEWPORT_HEIGHT);
}

/**
 * 左サイドバーのナビゲーション項目（li）が少なくとも 1 つビューポート内に見えていることを
 * 検証する。「.app__sidebar 全体は常に存在するが、ナビ項目は無くて背景だけの空白の帯になって
 * いる」という壊れ方（sticky でないサイドバーをスクロールで大きく追い越したときに起きる）を
 * 機械的に検知するための歯止め。
 */
async function expectSidebarNavPartiallyVisible(page: Page): Promise<void> {
  const anyVisible = await page.evaluate(() => {
    const items = document.querySelectorAll('#app-sidebar .app__nav-list li');
    return Array.from(items).some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    });
  });
  expect(anyVisible, '左サイドバーのナビ項目が 1 つも画面内に無い（真っ白な帯になっている疑い）').toBe(
    true
  );
}

test.describe('ストア掲載用スクリーンショット', () => {
  test('s1-protocol: 研究プロトコル入力（承認済み・読み取り専用表示）', async ({ page }) => {
    await injectAppStub(page, shotsScenario(protocolShotState()));
    await page.goto('/app/app.html#/protocol');

    await expect(page.locator('.protocol__readonly')).toBeVisible();
    await expect(page.locator('.protocol__summary')).toContainText('ARDS');
    await expectSidebarNavPartiallyVisible(page);

    // スクロール不要（先頭のまま、ヘッダー・サイドバー・本文がすべて収まる）
    await takeShot(page, 's1-protocol');
  });

  test('s2-blocks: 検索式ブロック承認（4 ブロック）', async ({ page }) => {
    await injectAppStub(page, shotsScenario(blocksShotState()));
    await page.goto('/app/app.html#/blocks');

    await expect(page.locator('.blocks__item')).toHaveCount(4);

    // blocksShotState() が SHOTS_PROTOCOL_DRAFT_SHORT（fixtures.ts。Framework・RQ の
    // 2 フィールドのみ）を使うことで「① ブロック一覧」見出しがページ y≈472 まで上がっており、
    // スクロール不要（先頭のまま）でヘッダー・サイドバー全 10 項目・プロトコル参照・見出し・
    // ブロックカード #1（バッジ・並び替え/削除ボタン・「ブロック名」欄の中身）・下部の
    // sticky アクションバーがすべて 800px に収まる。カード #1 の「説明」欄側は
    // sticky アクションバー（.blocks__actions は position:sticky; bottom:0。実際のアプリの
    // 挙動そのもの）の下に隠れるが、承認対象のブロック名（P (Population)）自体は読める。
    await takeShot(page, 's2-blocks');

    await expectSidebarNavPartiallyVisible(page);
    await expect(page.locator('#blocks-section-heading')).toBeInViewport();
    await expect(page.locator('.blocks__item').first()).toBeInViewport();
    await expect(page.locator('.blocks__label-input').first()).toBeInViewport();
    await expect(page.locator('.blocks__actions')).toBeInViewport();
  });

  test('s3-draft: 生成中のブロックごとのヒット数', async ({ page }) => {
    await injectAppStub(page, shotsScenario(draftRunningShotState()));
    await page.goto('/app/app.html#/draft');

    const hitItems = page.locator('.draft__block-hits li');
    await expect(hitItems).toHaveCount(4);
    // 「計測中…」のプレースホルダではなく、実際の件数が出揃っていることを確認する
    for (const li of await hitItems.all()) {
      await expect(li).toContainText('件');
    }

    // draftRunningShotState() が既存 formula の全文カードをあえて省いているため
    // （fixtures.ts のコメント参照）、ヘッダー・サイドバーのナビ・進捗トラッカー・
    // ブロックごとのヒット数一覧のすべてが 800px の折返し内に収まる。スクロール不要。
    await takeShot(page, 's3-draft');

    await expectSidebarNavPartiallyVisible(page);
    for (const li of await hitItems.all()) {
      await expect(li).toBeInViewport();
    }
  });

  test('s4-validation: 捕捉率・MeSH 検証結果', async ({ page }) => {
    await injectAppStub(page, shotsScenario(draftValidatedShotState()));
    await page.goto('/app/app.html#/draft');

    await expect(page.locator('.draft__validate-status')).toBeVisible();
    await expect(page.locator('.validate__mesh')).toContainText('Respiratory Distress Syndrome');

    // 見せたいのは「検証完了」「行ごとのヒット数」「捕捉率・未捕捉 PMID」「Seed の MeSH
    // （頻度順）」の 4 点で、その下に続く「MeSH 階層（Mermaid）」の生ソース（flowchart TD /
    // ノード定義の羅列）は含めたくない。.draft__validate-status へ scrollIntoView すると
    // 必要なスクロール量（実測 540px）がサイドバーのナビ総高さ（523px）を超え、サイドバーが
    // 丸ごと空白の帯になってしまう。代わりに、サイドバーのナビ項目の境界（6 番目
    // 「検索式編集」の上端 = 306px）にスクロール先を合わせる。この位置は実測で
    // (a) MeSH 頻度リストの下端が画面内（788px 止まり、800px 未満）に収まり
    // (b) 「MeSH 階層（Mermaid）」セクション（見出し含む）は画面外（807px〜）で一切写らない
    // という 2 条件を両立する数少ない区間で、かつナビ項目の境界と一致する。
    // MeSH 頻度を 5 件ではなく 4 件にしているのもこの区間を確保するため（fixtures.ts 参照）。
    await takeShot(page, 's4-validation', '#app-sidebar .app__nav-list li:nth-child(6)');

    await expectSidebarNavPartiallyVisible(page);
    await expect(page.locator('.draft__validate-status')).toBeInViewport();
    await expect(page.locator('.validate__line-hits')).toBeInViewport();
    await expect(page.locator('.validate__final')).toBeInViewport();
    await expect(page.locator('.validate__mesh h3')).toBeInViewport();
    // Mermaid の生ソースは画面内に写り込ませない
    await expect(page.locator('.validate__mesh-mermaid')).not.toBeInViewport();
  });

  test('s5-export: 各 DB 変換・エクスポート画面', async ({ page }) => {
    // exportToAllDatabases は変換ごとに Conversions タブへ appendRow する（4 回）。
    // 変換ロジック自体（convertToAllDatabases）はローカル計算のみで実 API を必要としないため、
    // ここで Sheets への書き込みだけ成功応答にしておけばボタン 1 クリックで結果が揃う。
    await page.route('**/sheets.googleapis.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await injectAppStub(page, shotsScenario(exportShotState()));
    await page.goto('/app/app.html#/export');

    await page.locator('.export__actions button').click();
    const results = page.locator('.export__result');
    await expect(results).toHaveCount(4);

    // 4 件すべてを開くと 800px の折返し内に収まらないため、1 件目（CENTRAL）だけ開いて
    // 「変換結果の中身が見える」ことを示しつつ、残り 3 件は DB 名の一覧として見せる。
    await results.first().evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });

    await expectSidebarNavPartiallyVisible(page);
    // スクロール不要（先頭のまま、ヘッダー・サイドバー・変換結果がすべて収まる）
    await takeShot(page, 's5-export');
  });
});
