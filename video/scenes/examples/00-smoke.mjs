// スモークテスト用シーン（シーンスクリプトの CONTRACT 例。PR1: 基盤 + スモークシーン1本）
//
// video/scripts/record.mjs のヘッダーコメントに書かれた CONTRACT に沿った最小構成のシーン。
// デモビルド（dist-demo/）はまだ無いため、素の `dist/`（npm run dev の出力。プロジェクト
// 未選択状態）で撮れる内容にしている。具体的には:
//   1. app/app.html を #/home で開く（ctx.openExtensionPage、本リポジトリ固有の適応点）
//   2. サイドナビ（プロトコル入力〜設定の全10項目。多くはプロジェクト未選択でグレーアウト）を
//      ゆっくりホバー
//   3. ホーム画面の「別のプロジェクトを開く…」ボタンをゆっくりホバー
//   4. ヘッダーのタイトル（ホームへ戻る導線）と「設定」ボタンをゆっくりホバー
// を行い、収録→TTS→合成の一連のパイプラインを音声付きで最後まで通す検証と、
// 可視カーソル（scenes/lib/cursor.mjs）が実際に映像へ映ることの確認を兼ねる。
//
// セレクタは実際に `npm run dev` の dist/ を Playwright で読み込み、DOM を確認したうえで
// 決めている（src/app/app.html・src/app/bootstrap.ts の renderSidebar / homeView.ts 参照）。
// 本拡張のヘッダーには「ヘルプ」ボタンが無い（設定ボタンのみ）ため、ヘルプ導線には触れない。
//
// 実際のチャプター（14本、デモビルド前提）は後続 PR で追加される。
// 実際のチャプター用シーンを書く際はこのファイルを土台にしてよい。
//
// pacing.mjs の使い方（このシーンが「お手本」にしている部分）:
//   このシーンは当初 ctx.sleep() に固定の秒数を決め打ちしていたため、ナレーションが
//   長い cue では画面操作がナレーションより先に終わり、tpad（assemble.mjs が動画尺を
//   ナレーション終了時刻に合わせて最終フレームを複製・引き伸ばす処理）が長時間の
//   静止画を作ってしまっていた（例: cue 01 のナレーションが30秒に対し、
//   ホバー操作は10秒足らずで終わっていたため、残り20秒が静止画になっていた）。
//   これを避けるため、各 cue で次の3手順を踏む:
//     (a) `loadCueDurations(narrationKey)` で video/build/audio/<key>/index.json
//         （tts.mjs の出力）から各 cue の実尺（秒）を読み込む
//     (b) `ctx.cue(n)` を打った直後に `Date.now()` で開始時刻を控える
//     (c) そのキューの画面操作を終えたら
//         `sleepRemainder(ctx, startedAt, durations['NN'] * 1000 + 500)` を呼び、
//         「ナレーションを喋り終える（+0.5秒の余白）」まで画面を保持してから
//         次の cue へ進む（操作の方が長ければ何もしない。sleepRemainder が
//         経過時間を見て不足分だけ待つため、二重に待つことはない）
//   また、ホバー操作自体の尺（hoverSequence の holdMs/moveMs）もナレーション尺に
//   概ね合わせておく（後述 cue 01 のコメント参照）。sleepRemainder はあくまで端数の
//   吸収用で、操作とナレーションの尺を最初から大きく乖離させたまま
//   sleepRemainder 任せにすると、「全項目を早口でホバーし終えたあと長時間立ち尽くす」
//   絵になり不自然。
//   前提: 原稿 → TTS → 収録の順を守ること（video/README.md 参照）。TTS 未実行だと
//   loadCueDurations が分かりやすい日本語エラーで落ちる。
//
// `video/scenes/` 直下ではなく `examples/` サブディレクトリに置いているのは、
// record.mjs のシーン列挙が拡張子 `.mjs` のファイルのみを対象とし、サブディレクトリを
// 無視するため（`npm run video:record` を引数無しで実行してもスモークテストは
// 収録対象に含まれない。単体で回すときは `node video/scripts/record.mjs 00-smoke` のように
// examples/ 配下のファイルも直接指定すれば収録できる）。

import { hoverSequence, hoverSlow } from '../lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from '../lib/pacing.mjs';

export default {
    id: '00',
    slug: 'smoke',
    title: 'スモークテスト',
    // このシーン専用の原稿（narration/00-smoke.md, subtitles/00-smoke.md）を使う。
    // 省略時も `${id}-${slug}` = '00-smoke' と同じキーになるため必須ではないが、
    // 意図を明確にするため明示している。
    narration: '00-smoke',
    // デモビルドが無く、プロジェクト未選択状態でも #/home のナビは一通り描画される
    // （src/app/guards.ts の evaluateGuards は project === null のとき home/protocol/settings
    // 以外を deny するが、サイドバー自体はディム表示のまま常に描画される）ので、
    // storageSeed（ログイン状態の投入）は不要。

    async run(ctx) {
        // 各 cue のナレーション実尺（秒）を先に読み込んでおく。TTS 未実行（原稿だけ
        // 変えて `node video/scripts/tts.mjs 00-smoke` を忘れた等）だと、ここで
        // 分かりやすい日本語エラーになって早期に気づける。
        const durations = loadCueDurations('00-smoke');

        // 本リポジトリ固有の適応点: tiab-review-plugin の sidepanel.html 決め打ちと異なり、
        // どの拡張内ページ・どの hash を開くかをシーン側が明示する。
        await ctx.openExtensionPage('app/app.html#/home');
        await ctx.page.locator('#app-sidebar .app__nav-list button').first().waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(800); // 画面が落ち着くまでの「間」（config.mjs の SCENE_LEAD_IN_SEC 目安）

        ctx.cue(1);
        const cue1StartedAt = Date.now();
        // サイドナビ（プロトコル入力〜設定の全10項目）を先頭から順にゆっくりホバーする。
        // プロジェクト未選択のため「プロトコル入力」「設定」以外は is-disabled でグレーアウト
        // している（src/app/guards.ts）が、ホバーするだけならクリックと違って遷移は起きない。
        // 可視カーソルの動作確認を兼ねるため、必ずマウス移動を伴う操作にしている。
        const navButtonCount = await ctx.page.locator('#app-sidebar .app__nav-list button').count();
        const navButtons = [];
        for (let i = 0; i < navButtonCount; i += 1) {
            navButtons.push(ctx.page.locator('#app-sidebar .app__nav-list button').nth(i));
        }
        // holdMs + moveMs = 2200ms/項目 × 10項目 ≒ 22秒。cue 01 のナレーション実尺
        // （durations['01']、原稿を「全10ステップ」に刈り込んだ現在は約22秒）に
        // 概ね合わせてある。ナレーションをさらに書き換えたときはここも調整すること
        // （合わせておかないと、全項目を早口でホバーし終えたあと sleepRemainder で
        // 長時間立ち尽くす不自然な絵になる）。
        await hoverSequence(ctx.page, navButtons, { holdMs: 1300, moveMs: 900 });
        // ホバーし終えてもナレーションがまだ流れていれば、喋り終える(+0.5秒)まで
        // 画面をこのまま保持してから次の cue へ進む。
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        ctx.cue(2);
        const cue2StartedAt = Date.now();
        // ホーム画面（プロジェクト未選択時の案内文）に出ている
        // 「別のプロジェクトを開く…」ボタンをホバー（src/app/views/homeView.ts）
        await hoverSlow(ctx.page, ctx.page.locator('.home__switch-project'), { durationMs: 600 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        ctx.cue(3);
        const cue3StartedAt = Date.now();
        // ヘッダーのタイトル（クリックで #/home へ戻る導線）と
        // 「設定」ボタン（#/settings への遷移導線）を順にホバー
        await hoverSlow(ctx.page, ctx.page.locator('#app-home-link'), { durationMs: 500 });
        await ctx.sleep(400);
        await hoverSlow(ctx.page, ctx.page.locator('#app-settings-link'), { durationMs: 500 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);
    },
};
