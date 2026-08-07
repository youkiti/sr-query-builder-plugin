// popup.html 用のページ拡大ヘルパー（本リポジトリ固有）
//
// popup.html は幅 320px 固定の中央カラムレイアウトのため、1920x1080 の収録解像度では
// 画面の大半が空白になり文字が非常に小さく映る（app.html / options.html は逆に
// 十分に画面を埋めるため対象外）。ここでは `document.body.style.zoom` を使って
// popup.html だけを拡大し、可読性を確保する。
//
// `zoom` を採用する理由（transform: scale ではなく）:
//   `zoom` はレイアウトに影響するプロパティ（transform と異なり実際のボックスサイズ・
//   ヒットテスト座標を変更する）ため、Playwright の locator.boundingBox() が
//   拡大後の座標をそのまま返す。そのため scenes/lib/gestures.mjs の hoverSlow /
//   hoverSequence は本ヘルパー適用の有無に関わらず変更なしで正しく動作する
//   （transform: scale だと boundingBox() は拡大"前"の座標を返してしまい、
//   実際の描画位置とズレが生じる）。
//
// 重要: `zoom` はナビゲーション（page.goto 等）のたびにリセットされる。
// ctx.openExtensionPage() で popup.html を開くたびに、直後に必ず applyPageZoom() を
// 呼び直すこと（本ヘルパーは自動では再適用されない）。
//
// 可視カーソル（scenes/lib/cursor.mjs）は document.body ではなく
// document.documentElement（<html>）直下に注入しているため、ここで body にかける
// zoom の影響を受けず、常に正しいビューポート座標へ描画される。

/**
 * 現在のページ（document.body）に CSS zoom を適用する。
 * @param {import('playwright').Page} page
 * @param {number} factor 拡大率（例: 1.8 なら 180%）
 */
export async function applyPageZoom(page, factor) {
    await page.evaluate((f) => {
        document.body.style.zoom = String(f);
    }, factor);
}
