/** ツアー一覧を開いて指定のツアーを始める。一覧が開いていれば先に閉じる必要はない（開閉は入口のボタンが切り替える）。 */
export async function startTour(run, id) {
    // ツアーの初期化（保存値の読み込み）が終わると、ボタンに aria-controls が付く。それより前に押しても一覧は開かない
    await run.visible('#app-open-tours[aria-controls="guide-tour-list"]');
    await run.click('#app-open-tours');
    await run.click(`#guide-tour-list [data-guide-action="start"][data-guide-tour="${id}"]`);
}

/** 画面を移動する（サイドバーの項目を押す）。 */
export async function goNav(run, route) {
    // ホームはサイドバーに無く、見出しのリンクから戻る。
    await run.click(route === 'home' ? '#app-home-link' : `[data-tour="nav-${route}"]`);
    await run.action(`画面が ${route} になる`, () => run.page.waitForURL(`**#/${route}`));
}
