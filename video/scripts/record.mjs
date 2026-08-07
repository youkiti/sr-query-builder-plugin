#!/usr/bin/env node
// シーン収録スクリプト
//
// 使い方:
//   node video/scripts/record.mjs                 # video/scenes/ 配下の全シーンを収録
//   node video/scripts/record.mjs 00-smoke 03-blocks  # 指定シーンのみ収録
//   (引数は "NN-slug" のフルネームでも "NN" の数字部分だけでも一致させられる)
//
// 前提: 収録対象の拡張機能ビルド（config.mjs の resolveExtensionDir() が解決するディレクトリ。
// 既定では `npm run dev` で生成される dist/）が存在すること。
// Chrome 拡張機能の録画には仮想ディスプレイが必要なため、Linux では以下のように
// xvfb 経由で実行する。
//   xvfb-run -a -s "-screen 0 1920x1080x24" node video/scripts/record.mjs
//
// ==========================================================================
// シーンスクリプトの CONTRACT（video/scenes/NN-slug.mjs が実装する形）
// ==========================================================================
//
// export default {
//   id: 'NN',                    // 2桁のシーン番号（文字列。ファイル名の NN と一致させる）
//   slug: 'slug-name',           // ファイル名の slug 部分と一致させる
//   title: 'シーンタイトル',       // chapters.txt 等で使うシーン名（narration frontmatter が
//                                 // 無い/対応が無い場合のフォールバックとして使われる）
//
//   // 省略可: このシーンが読み上げるナレーション原稿のキー（video/narration/<key>.md /
//   // video/subtitles/<key>.md）。省略時は `${id}-${slug}` と同じキーを使う。
//   // ナレーション原稿を持たない（映像のみの）シーンを作る場合は narration: null を指定する。
//   narration: 'NN-slug',
//
//   // 省略可: 収録前に chrome.storage.local へ流し込む初期状態（ログイン済み状態にする等）。
//   // 例: { demo_signed_in: true }
//   storageSeed: { ... },
//
//   // シーン本体。ctx を使って画面操作とキュー打刻を行う。
//   async run(ctx) {
//     // 拡張内ページを開く（本リポジトリ固有の適応点。下記 ctx API 一覧を参照）。
//     // tiab-review-plugin のようなサイドパネル1枚構成ではなく、本拡張は
//     // app/app.html（hash ルーティング）・popup/popup.html・options/options.html の
//     // 複数ページ構成のため、シーン側がどのページ・どの hash を開くかを明示する。
//     await ctx.openExtensionPage('app/app.html#/home');
//     await ctx.sleep(800);   // 画面が落ち着くのを待つ（SCENE_LEAD_IN_SEC 目安）
//     ctx.cue(1);             // ナレーション cue 01 の発声タイミングを記録
//     await ctx.sleep(2000);
//     ctx.cue(2);
//     ...
//   },
// }
//
// ctx (RecordContext) が提供する API:
//   ctx.page                       : 現在アクティブな Playwright Page（録画対象）
//   ctx.extId                      : 読み込んだ拡張機能の ID（chrome-extension://<extId>/...）
//   ctx.openExtensionPage(path)    : 拡張内ページを開く（本リポジトリ固有の適応点）。
//                                    path は `app/app.html#/home` のように拡張ルートからの
//                                    相対パス（+ 任意でクエリ/hash）を渡す。内部で
//                                    `chrome-extension://<extId>/<path>` へ ctx.page.goto() する。
//   ctx.cue(n)                     : キュー n の発声タイミング（アクティブなセグメント開始からの
//                                    相対秒数）を記録し、進捗をログ出力する。n は数値または
//                                    '01' のような文字列のどちらでもよい（内部で2桁ゼロ埋め文字列化）。
//   ctx.newSegment(page)           : 新しいタブに録画対象を切り替える。セグメント境界を記録し、
//                                    以後の ctx.cue()/ctx.page/ctx.openExtensionPage はこの
//                                    page を基準にする。
//   ctx.sleep(ms)                  : 指定ミリ秒待つ（await 可能）。
//
// 収録結果は video/build/scenes/<NN-slug>/ に書き出される:
//   segment-0.webm, segment-1.webm, ...   各セグメントの録画（Playwright の webm）
//   meta.json                             セグメント一覧・キュー時刻などのメタデータ
//
// タイミング精度についての注意（重要）:
//   Playwright は「そのページが作成された瞬間」から録画を開始する。ページ内の
//   chrome.tabs 等で最初から開いているページ（launchPersistentContext 直後に存在する
//   about:blank）は、録画開始とシーン内の実際の操作開始（page.goto 等）の間にズレが
//   生じやすい。このズレを避けるため、本収録スクリプトは「シーンの主ページ」を
//   ctx.page として渡す前に newPage() で作り直し、そのページ生成時刻を t0 として扱う。
//   sub秒（1秒未満）オーダーの誤差は許容し、ナレーション尺に対して十分な余裕
//   （MIN_CUE_GAP_SEC 等）を assemble.mjs 側で確保することで吸収する設計とする。
//
// 可視マウスカーソルについて（tiab-review-plugin/video には無い、本リポジトリでの新規機能）:
//   browserContext 生成直後に scenes/lib/cursor.mjs の installCursor() を呼び、
//   全ページ・全ナビゲーションに可視カーソル（擬似カーソル DOM 要素）を自動注入する。
//   シーンスクリプト側で追加の配線は不要（詳細は cursor.mjs 冒頭のコメントを参照）。

import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, renameSync, copyFileSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import {
    BUILD_SCENES_DIR,
    SCENES_DIR,
    VIDEO_WIDTH,
    VIDEO_HEIGHT,
    resolveChromiumExecutable,
    resolveExtensionDir,
} from './config.mjs';
import { installCursor } from '../scenes/lib/cursor.mjs';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ファイルを別ファイルシステムをまたいでも移動できるようにする renameSync のラッパー。
 * os.tmpdir()（録画の一時出力先）と video/build/（リポジトリ側）が別マウントの場合、
 * renameSync は EXDEV で失敗するため、その場合のみ copyFileSync + unlinkSync にフォール
 * バックする（同一ファイルシステムでは高速な rename をそのまま使う）。
 */
function moveFile(srcPath, destPath) {
    try {
        renameSync(srcPath, destPath);
    } catch (err) {
        if (err && err.code === 'EXDEV') {
            copyFileSync(srcPath, destPath);
            unlinkSync(srcPath);
        } else {
            throw err;
        }
    }
}

/** 2桁ゼロ埋め文字列に正規化する（1 -> '01', '01' -> '01'） */
function padCue(n) {
    return String(n).padStart(2, '0');
}

/**
 * 一時プロファイル/録画ディレクトリの削除ラッパー。
 *
 * 収録自体が成功していても、Chromium プロセスの終了（ロックファイル解放）と rmSync の
 * タイミングが競合し、ディレクトリがまだ空になりきっていない状態で削除しようとして
 * ENOTEMPTY を投げることがある（移植元 sr-data-extraction-plugin の収録時に観測された）。
 * rmSync の maxRetries / retryDelay で数回リトライさせたうえで、それでも失敗する場合は
 * 例外を投げず警告ログに留める。収録結果（video/build/scenes/ 配下）は既にこの関数の
 * 呼び出し時点で書き出し済みのため、OS 一時ディレクトリの後片付け失敗でプロセス全体を
 * 異常終了させる価値はない（不要になった一時ディレクトリが OS の再起動やクリーナーで
 * 後から片付いても実害がない）。
 */
function safeRmSync(targetPath, label) {
    try {
        rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (err) {
        console.warn(`[警告] ${label} の削除に失敗しました（無視して続行します）: ${targetPath}`);
        console.warn(`  理由: ${err && err.message ? err.message : err}`);
    }
}

/** video/scenes/ 配下の *.mjs をシーン番号順に列挙する（examples/ 等のサブディレクトリは対象外） */
function listSceneFiles() {
    if (!existsSync(SCENES_DIR)) return [];
    return readdirSync(SCENES_DIR)
        .filter((f) => f.endsWith('.mjs'))
        .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * video/scenes/examples/ 配下の *.mjs を列挙する（`examples/00-smoke.mjs` のように
 * サブディレクトリ付きの相対パスで返す）。実チャプター収録の対象外だが、CLI 引数で
 * 明示指定された場合の解決先として使う（下記 filterSceneFiles 参照）。
 */
function listExampleSceneFiles() {
    const examplesDir = path.join(SCENES_DIR, 'examples');
    if (!existsSync(examplesDir)) return [];
    return readdirSync(examplesDir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => path.join('examples', f))
        .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * CLI 引数（フル名 or NN番号）にマッチするシーンファイルを絞り込む。
 * まず `video/scenes/` 直下（実チャプター）から探し、見つからなければ
 * `video/scenes/examples/`（スモークテスト等）にフォールバックする。
 * これにより `node video/scripts/record.mjs 00-smoke` のように明示指定したときだけ
 * examples/ 配下も収録できる（引数無しの一括収録では examples/ は含まれない）。
 */
function filterSceneFiles(allFiles, args) {
    if (args.length === 0) return allFiles;
    const selected = [];
    for (const arg of args) {
        const matchesIn = (files) => files.find((f) => {
            const base = path.basename(f, '.mjs');
            return base === arg || base.startsWith(`${arg}-`);
        });
        const match = matchesIn(allFiles) || matchesIn(listExampleSceneFiles());
        if (!match) {
            throw new Error(
                `指定されたシーンが見つかりません: ${arg}` +
                '（video/scenes/ 直下・video/scenes/examples/ 配下を確認してください）',
            );
        }
        if (!selected.includes(match)) selected.push(match);
    }
    return selected;
}

/**
 * シーン1本を収録する。
 * @param {string} sceneFile video/scenes/ 配下のファイル名（例: '00-smoke.mjs'）
 * @param {string} extensionDir 収録対象の拡張機能ビルドディレクトリ（config.mjs の resolveExtensionDir() が解決した値）
 */
async function recordScene(sceneFile, extensionDir) {
    const scenePath = path.join(SCENES_DIR, sceneFile);
    const mod = await import(`${scenePath}?t=${Date.now()}`); // キャッシュ回避
    const scene = mod.default;
    if (!scene || typeof scene.run !== 'function') {
        throw new Error(`シーンモジュールの形式が不正です（default export に run() が必要）: ${sceneFile}`);
    }
    const sceneKey = `${scene.id}-${scene.slug}`;
    console.log(`\n=== シーン収録開始: ${sceneKey}（${scene.title || ''}） ===`);

    const profileDir = mkdtempSync(path.join(os.tmpdir(), `sr-qb-video-profile-${sceneKey}-`));
    const videoDir = mkdtempSync(path.join(os.tmpdir(), `sr-qb-video-rec-${sceneKey}-`));

    const executablePath = resolveChromiumExecutable();
    const launchOptions = {
        headless: false,
        viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
        locale: 'ja',
        args: [
            `--disable-extensions-except=${extensionDir}`,
            `--load-extension=${extensionDir}`,
            `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`,
            '--lang=ja',
        ],
        recordVideo: { dir: videoDir, size: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT } },
    };
    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    const browserContext = await chromium.launchPersistentContext(profileDir, launchOptions);

    try {
        // 可視カーソルの注入登録は、最初のページ遷移が起きるより前に行う（cursor.mjs 参照）。
        // コンテキストレベルの登録のため、以後この関数内で作る全ページ・全ナビゲーションに
        // 自動的に適用される。
        await installCursor(browserContext);

        let sw = browserContext.serviceWorkers()[0];
        if (!sw) sw = await browserContext.waitForEvent('serviceworker', { timeout: 20000 });
        const extId = new URL(sw.url()).host;
        console.log(`拡張機能ID: ${extId}`);

        // launchPersistentContext は最初から about:blank ページを1枚持っていることが多い。
        // このページの録画はコンテキスト生成直後から始まっておりタイミングが不正確なため、
        // 本収録には使わず、storageSeed の投入にだけ使ってから閉じる（video は破棄される）。
        const initialPages = browserContext.pages();
        const bootstrapPage = initialPages[0] ?? await browserContext.newPage();

        if (scene.storageSeed) {
            await bootstrapPage.goto(`chrome-extension://${extId}/popup/popup.html`);
            await bootstrapPage.evaluate((seed) => {
                return chrome.storage.local.set(seed);
            }, scene.storageSeed);
            console.log('storageSeed を chrome.storage.local へ投入しました');
        }
        await bootstrapPage.close();

        // セグメント管理
        const segments = []; // [{ page, t0Wallclock }]
        let activeIndex = -1;
        const cues = [];

        function newSegment(page) {
            segments.push({ page, t0Wallclock: Date.now() });
            activeIndex = segments.length - 1;
            console.log(`[${sceneKey}] セグメント ${activeIndex} 開始`);
        }

        function cue(n) {
            if (activeIndex < 0) {
                throw new Error('ctx.cue() を呼ぶ前に newSegment（主ページ生成）が必要です');
            }
            const nn = padCue(n);
            const tRel = (Date.now() - segments[activeIndex].t0Wallclock) / 1000;
            cues.push({ n: nn, segment: activeIndex, tRel });
            console.log(`[${sceneKey}] cue ${nn} @ segment ${activeIndex} t=${tRel.toFixed(2)}s`);
        }

        // シーンの主ページをここで新規作成する（タイミング精度確保のための本収録スクリプト側の
        // 意図的な工夫。上部コメントのタイミング精度に関する注意を参照）。
        // どの拡張内ページを開くかはシーン側が ctx.openExtensionPage() で決める
        // （tiab-review-plugin の pageQuery 方式と異なり、本拡張は app/popup/options の
        // 複数ページ構成のため、収録スクリプト側で決め打ちしない）。
        const mainPage = await browserContext.newPage();
        newSegment(mainPage);

        const ctx = {
            get page() { return segments[activeIndex].page; },
            extId,
            cue,
            newSegment,
            sleep,
            async openExtensionPage(pagePath) {
                const normalized = pagePath.startsWith('/') ? pagePath.slice(1) : pagePath;
                await ctx.page.goto(`chrome-extension://${extId}/${normalized}`);
            },
        };

        await scene.run(ctx);

        await browserContext.close();

        // 録画ファイルを video/build/scenes/<sceneKey>/segment-K.webm へ配置する
        const outDir = path.join(BUILD_SCENES_DIR, sceneKey);
        mkdirSync(outDir, { recursive: true });
        const segmentMeta = [];
        for (let i = 0; i < segments.length; i += 1) {
            const srcPath = await segments[i].page.video().path();
            const destName = `segment-${i}.webm`;
            const destPath = path.join(outDir, destName);
            moveFile(srcPath, destPath);
            segmentMeta.push({ file: destName, t0Wallclock: segments[i].t0Wallclock });
        }

        const narrationKey = scene.narration === null
            ? null
            : (scene.narration || sceneKey);

        const meta = {
            sceneId: scene.id,
            slug: scene.slug,
            title: scene.title || '',
            narrationKey,
            segments: segmentMeta,
            cues,
        };
        writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
        console.log(`書き出し完了: ${path.join(outDir, 'meta.json')}`);
    } finally {
        // launchPersistentContext は close() で例外時も後始末されるが、二重 close を避けるため
        // isConnected 相当のチェックは行わず try/catch で握りつぶす
        await browserContext.close().catch(() => {});
        safeRmSync(profileDir, '一時プロファイルディレクトリ');
        safeRmSync(videoDir, '一時録画ディレクトリ');
    }
}

async function main() {
    const args = process.argv.slice(2);
    const extensionDir = resolveExtensionDir();
    console.log(`収録対象の拡張機能ビルド: ${extensionDir}`);
    const allFiles = listSceneFiles();
    // 引数無し（一括収録）のときだけ「video/scenes/ 直下にシーンが無い」を致命的エラーにする。
    // 引数ありのときは examples/ 配下（スモークテスト等）だけの解決も許すため、ここでは
    // 早期リターンせず filterSceneFiles 側の解決に委ねる（PR1 時点は実チャプターが
    // まだ無く allFiles が空でも 00-smoke は examples/ から解決できる）。
    if (allFiles.length === 0 && args.length === 0) {
        throw new Error(`video/scenes/ にシーンスクリプトがありません: ${SCENES_DIR}`);
    }
    const targetFiles = filterSceneFiles(allFiles, args);

    // launchPersistentContext 直後の browserContext.newPage()（本関数内の mainPage 生成）が、
    // 収録内容とは無関係に "Protocol error (Target.createTarget): Failed to open a new tab" で
    // 稀に失敗することがある（サンドボックス環境での Chromium 起動直後の一時的な競合と見られる。
    // 移植元 sr-data-extraction-plugin の収録では複数シーンにわたり断続的に発生し、毎回
    // リトライで成功することを確認した経緯がある）。実チャプター収録の途中で 1 章でも
    // 失敗すると全体が止まってしまうため、シーン単位で数回まで自動リトライする（収録結果は
    // シーンごとに独立しており、リトライしても既に成功した先行シーンの結果には影響しない）。
    const MAX_ATTEMPTS_PER_SCENE = 4;
    for (const sceneFile of targetFiles) {
        let lastErr;
        let succeeded = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SCENE; attempt += 1) {
            try {
                await recordScene(sceneFile, extensionDir);
                succeeded = true;
                break;
            } catch (err) {
                lastErr = err;
                console.warn(
                    `[警告] ${sceneFile} の収録に失敗しました（試行 ${attempt}/${MAX_ATTEMPTS_PER_SCENE}）: ${err && err.message ? err.message : err}`,
                );
            }
        }
        if (!succeeded) {
            throw lastErr;
        }
    }
    console.log(`\n収録完了: ${targetFiles.length} シーン`);
}

main().catch((err) => {
    console.error('収録に失敗しました:', err);
    process.exit(1);
});
