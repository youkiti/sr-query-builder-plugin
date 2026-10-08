// デモビルド上の操作ツアーを順に実行する。headed ブラウザが必要なため CI 外で使う。
// --only <ツアー ID> / --lang ja|en / --size <幅>x<高さ> / --settle <ミリ秒>（0〜10000、既定 0）
// --settle は手順画像の撮影前だけ待つ。失敗画像や完了画像は待たない。
import { readdirSync, mkdirSync } from 'node:fs';
import { parseArgs } from './lib/options.mjs';
import { defineScenario, selectScenarios } from './lib/scenario.mjs';
import { executeScenarios, summarize } from './lib/results.mjs';
import { OUT_DIR, resolveDemoDir } from './lib/paths.mjs';
import { withFreshBrowser } from './lib/browser.mjs';

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const extensionDir = resolveDemoDir();
    const directory = new URL('./scenarios/', import.meta.url);
    const scenarios = [];
    for (const file of readdirSync(directory).filter(f => f.endsWith('.mjs')).sort()) {
        const scenario = defineScenario((await import(new URL(file, directory).href)).default);
        if (file !== `${scenario.name}.mjs`) throw new Error(`ファイル名とシナリオ名が一致しません: ${file}`);
        scenarios.push(scenario);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    const results = await executeScenarios(selectScenarios(scenarios, options.only), async (scenario, warnings) => {
        console.log(`開始: ${scenario.name}（${scenario.title}）`);
        await withFreshBrowser({
            ...scenario,
            run: run => {
                run.settle = options.settle;
                return scenario.run(run);
            },
        }, options, extensionDir, warnings);
    });
    const summary = summarize(results);
    console.log(summary.text);
    console.log(`画像: ${OUT_DIR}`);
    // パイプへの集計・警告の書き込みが完了してから、残った接続ごと終了する。
    await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))));
    process.exit(summary.exitCode);
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
