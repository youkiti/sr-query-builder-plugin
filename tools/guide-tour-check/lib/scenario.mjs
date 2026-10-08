// シナリオの書き方:
// scenarios/<ツアー ID>.mjs で defineScenario({ name: '<ツアー ID>', title: '説明', async run(run) { ... } })
// を default export する。追加したファイルは自動で名前順に実行される。
// 各シナリオは新しい一時プロファイルを使い、実データ・実 API は使わない（デモビルドが通信を差し替える）。
// run.step(手順 ID, 対象の data-tour) でカードと配置を確認し、画像を残す。
// 対象が出せない手順は run.waitingStep(手順 ID) で、待機の状態のまま画像を残す（動画の素材としては弱いので最小限にする）。
// 操作・待ちは run.action(条件の説明, 関数) で包むと、失敗時に手順・カード・URL が残る。
// 共通の操作と確認は lib/run.mjs、ブラウザの起動と片づけは lib/browser.mjs に置く。
// 画像のファイル名は `<シナリオ名>-<連番>-<手順 ID>.png`。シナリオ名はツアー ID と同じにすること
// （動画の生成が、ツアー ID と手順 ID でファイル名を引く）。

export function defineScenario(value) {
    if (!value || typeof value.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)) {
        throw new Error('シナリオ名は小文字・数字・ハイフンで指定してください');
    }
    if (typeof value.title !== 'string' || !value.title.trim() || typeof value.run !== 'function') {
        throw new Error(`シナリオ ${value.name} に title と run 関数が必要です`);
    }
    return value;
}

export function selectScenarios(scenarios, only) {
    const names = new Set();
    for (const scenario of scenarios) {
        defineScenario(scenario);
        if (names.has(scenario.name)) throw new Error(`シナリオ名が重複しています: ${scenario.name}`);
        names.add(scenario.name);
    }
    const selected = only === null ? scenarios : scenarios.filter(s => s.name === only);
    if (!selected.length) throw new Error(`対象シナリオがありません: ${only ?? '全件'}`);
    return selected;
}
