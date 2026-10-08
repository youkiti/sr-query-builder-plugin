/**
 * ヘルプツアー 4 本（はじめての流れ・検索式の作成と自動調整・シードの拡張・編集と書き出し）のスモーク。
 * 「次へ」「押さずに次へ」とサイドバーのクリックだけで最後まで進める。AI の呼び出しや保存は押さない。
 * 共通スタブは既定で提案帯を止めている（fixtures/appStub.ts の GUIDE_PROGRESS_SUPPRESSED）。
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';
import { FULL_BLOCKS_DRAFT, FULL_PROTOCOL_DRAFT, fullStateScenario } from './fixtures/scenarios/fullState';

const HOME_URL = '/app/app.html#/home';
const DRAFT_URL = '/app/app.html#/draft';

/** initGuide は非同期で、入口のボタンに aria-controls が付く前に押すと何も起きない。 */
async function waitForGuide(page: Page): Promise<void> {
  await page.waitForSelector('#app-open-tours[aria-controls]');
}

/** ヘッダーの「ツアー」から一覧を開き、指定のツアーを始める。 */
async function startFromList(page: Page, tourId: string): Promise<Locator> {
  await page.locator('#app-open-tours').click();
  await page.locator(`#guide-tour-list [data-guide-action="start"][data-guide-tour="${tourId}"]`).click();
  return page.locator('.guide-tour-card');
}

/** 手順のカードが出て、n / m の表示と、対象が画面にあるか（待機かどうか）が期待どおりであること。 */
async function expectStep(card: Locator, stepId: string, position: string, waiting: boolean): Promise<void> {
  await expect(card).toHaveAttribute('data-guide-step', stepId);
  await expect(card).toContainText(position);
  await expect(card).toHaveAttribute('data-guide-waiting', String(waiting));
}

const next = (card: Locator): Locator => card.locator('[data-guide-action="next"]');
const skip = (card: Locator): Locator => card.locator('[data-guide-action="skip"]');

/** 最後の「完了」を押すと、カードが消え、一覧の見出しに「済み」が付く。 */
async function finishAndExpectDone(page: Page, card: Locator, tourId: string): Promise<void> {
  await expectStep(card, 'finish', '', false);
  await next(card).click();
  await expect(card).toHaveCount(0);
  await page.locator('#app-open-tours').click();
  const entry = page.locator(`#guide-tour-list [data-guide-action="start"][data-guide-tour="${tourId}"]`);
  await expect(entry).toHaveCount(1);
  await expect(page.locator('#guide-tour-list h2', { hasText: '済み' })).toHaveCount(1);
}

test.describe('app-guide-tours (ツアー 4 本)', () => {
  test('はじめての流れ: ブロック承認まで解析済みの状態から、最後まで進めて「済み」が付く', async ({ page }) => {
    // プロトコルは解析済み（未保存）。プロトコル入力の 2 手順は飛ばされ、承認の手順は残る。
    await injectAppStub(page, scenarioWithProject({
      preloadedState: { ...scenarioWithProject().preloadedState, protocolDraft: FULL_PROTOCOL_DRAFT, blocksDraft: FULL_BLOCKS_DRAFT },
    }));
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const card = await startFromList(page, 'getting-started');
    await expectStep(card, 'welcome', '1 / 8', false);
    await next(card).click();
    await expectStep(card, 'open-blocks', '2 / 8', false);
    await page.locator('[data-tour="nav-blocks"]').click();
    await expect(page).toHaveURL(/#\/blocks$/);
    await expectStep(card, 'review-blocks', '3 / 8', false);
    await next(card).click();
    await expectStep(card, 'review-filters', '4 / 8', false);
    await next(card).click();
    // 承認は保存を伴うので押さずに進める
    await expectStep(card, 'approve-blocks', '5 / 8', false);
    await expect(skip(card)).toBeVisible();
    await skip(card).click();
    await expectStep(card, 'open-seeds', '6 / 8', false);
    await page.locator('[data-tour="nav-seeds"]').click();
    await expect(page).toHaveURL(/#\/seeds$/);
    await expectStep(card, 'add-seeds', '7 / 8', false);
    await next(card).click();
    await finishAndExpectDone(page, card, 'getting-started');
  });

  test('検索式の作成と自動調整: 実行しないまま最後まで進め、実行後に現れる手順は待機のまま「次へ」で進める', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const card = await startFromList(page, 'draft-and-optimize');
    await expectStep(card, 'open-draft', '1 / 8', false);
    await page.locator('[data-tour="nav-draft"]').click();
    await expect(page).toHaveURL(/#\/draft$/);
    await expectStep(card, 'optimize-settings', '2 / 8', false);
    await next(card).click();
    // AI と PubMed への通信を伴うので、押さずに進める
    await expectStep(card, 'optimize-start', '3 / 8', false);
    await expect(page.locator('[data-tour="draft-optimize-start"]')).toHaveText('検索式を作成・自動調整する');
    await skip(card).click();
    // 自動調整を実行していないので、履歴・最終レビュー・保留候補は画面に無い（待機）
    await expectStep(card, 'optimize-history', '4 / 8', true);
    await next(card).click();
    await expectStep(card, 'optimize-review', '5 / 8', true);
    await next(card).click();
    await expectStep(card, 'held-candidates', '6 / 8', true);
    await next(card).click();
    // 現在の検索式があるので、補助操作は画面にある
    await expectStep(card, 'revalidate', '7 / 8', false);
    await next(card).click();
    await finishAndExpectDone(page, card, 'draft-and-optimize');
  });

  test('シードの拡張: 取得せずに最後まで進める', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const card = await startFromList(page, 'expand-seeds');
    await expectStep(card, 'open-expand', '1 / 5', false);
    await page.locator('[data-tour="nav-expand"]').click();
    await expect(page).toHaveURL(/#\/expand$/);
    await expectStep(card, 'fetch-candidates', '2 / 5', false);
    await expect(page.locator('[data-tour="expand-fetch"]')).toHaveText('境界事例を取得');
    await skip(card).click();
    // 取得していないので、候補の一覧と更新提案は画面に無い（待機）
    await expectStep(card, 'judge-candidates', '3 / 5', true);
    await next(card).click();
    await expectStep(card, 'update-proposals', '4 / 5', true);
    await next(card).click();
    await finishAndExpectDone(page, card, 'expand-seeds');
  });

  test('編集と書き出し: 保存も変換も押さずに最後まで進める', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const card = await startFromList(page, 'edit-and-export');
    await expectStep(card, 'open-edit', '1 / 8', false);
    await page.locator('[data-tour="nav-edit"]').click();
    await expect(page).toHaveURL(/#\/edit$/);
    await expectStep(card, 'edit-blocks', '2 / 8', false);
    await next(card).click();
    // インスペクタは、ブロックを開くまで画面に無い（待機）
    await expectStep(card, 'inspect-block', '3 / 8', true);
    await next(card).click();
    await expectStep(card, 'save-version', '4 / 8', false);
    await expect(page.locator('[data-tour="edit-save"]')).toHaveText('新バージョンとして保存');
    await skip(card).click();
    await expectStep(card, 'open-export', '5 / 8', false);
    await page.locator('[data-tour="nav-export"]').click();
    await expect(page).toHaveURL(/#\/export$/);
    await expectStep(card, 'run-export', '6 / 8', false);
    await expect(page.locator('[data-tour="export-run"]')).toHaveText('4 DB へ変換して保存');
    await next(card).click();
    // 変換していないので、結果は画面に無い（待機）
    await expectStep(card, 'convert-databases', '7 / 8', true);
    await next(card).click();
    await finishAndExpectDone(page, card, 'edit-and-export');
  });

  test('プロジェクト未選択では、前提のいる 3 本（検索式の作成と自動調整・シードの拡張・編集と書き出し）が一覧に出ない', async ({ page }) => {
    const unavailable = ['draft-and-optimize', 'expand-seeds', 'edit-and-export'];
    const tourButton = (id: string): Locator =>
      page.locator(`#guide-tour-list [data-guide-action="start"][data-guide-tour="${id}"]`);

    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    await expect(tourButton('getting-started')).toHaveCount(1);
    for (const id of unavailable) await expect(tourButton(id)).toHaveCount(0);
  });

  test('プロジェクトはあるがブロック未承認・検索式なしの状態でも、後ろの 3 本は一覧に出ない', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    await expect(page.locator('#guide-tour-list [data-guide-action="start"][data-guide-tour="getting-started"]')).toHaveCount(1);
    for (const id of ['draft-and-optimize', 'expand-seeds', 'edit-and-export']) {
      await expect(page.locator(`#guide-tour-list [data-guide-action="start"][data-guide-tour="${id}"]`)).toHaveCount(0);
    }
  });

  test('検索式がそろっていれば、4 本とも一覧に出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    await expect(page.locator('#guide-tour-list [data-guide-action="start"]')).toHaveCount(4);
  });

  test('#/draft の「?」メニューに「ここからツアーを始める」が出て、押すと検索式の作成と自動調整が始まる', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(DRAFT_URL);
    await waitForGuide(page);
    await page.locator('#app-content h2 + .guide-help-btn').click();
    const start = page.locator('.guide-help-menu [data-help-action="start-tour"]');
    await expect(start).toHaveText('ここからツアーを始める');
    await start.click();
    const card = page.locator('.guide-tour-card');
    await expect(card).toHaveAttribute('aria-label', '検索式の作成と自動調整');
    // すでに #/draft にいるので、画面を開く手順は飛ばして、その次から始まる
    await expectStep(card, 'optimize-settings', '1 / 7', false);
  });
});
