// 動画制作パイプライン共通設定
//
// record.mjs / tts.mjs / assemble.mjs から共通で読み込む。パス解決・解像度・
// VOICEVOX 接続先・ffmpeg/ffprobe の探索順など、パイプライン全体の定数をここに集約する。
// 値を変更すればパイプライン全体に反映される。
//
// sr-data-extraction-plugin/video からの移植時の適応点（PR1）:
//   本拡張はまだデモビルド（dist-demo/）を持たないため、収録対象ディレクトリの解決を
//   固定パスの export ではなく resolveExtensionDir() 関数にした（下記参照）。

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリルート（video/scripts/ の2階層上） */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** video/ ディレクトリ */
export const VIDEO_ROOT = path.resolve(__dirname, '..');

/** 生成物の出力先（git 管理外） */
export const BUILD_DIR = path.join(VIDEO_ROOT, 'build');
export const BUILD_SCENES_DIR = path.join(BUILD_DIR, 'scenes');
export const BUILD_AUDIO_DIR = path.join(BUILD_DIR, 'audio');

/** シーンスクリプト・原稿・字幕ソースの置き場所 */
export const SCENES_DIR = path.join(VIDEO_ROOT, 'scenes');
export const NARRATION_DIR = path.join(VIDEO_ROOT, 'narration');
export const SUBTITLES_DIR = path.join(VIDEO_ROOT, 'subtitles');
export const ASSETS_DIR = path.join(VIDEO_ROOT, 'assets');

/** 映像の解像度・フレームレート（全シーン共通） */
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const FPS = 30;

/** サムネイルの解像度（YouTube 推奨サイズ） */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/** VOICEVOX エンジン接続先。環境変数で上書き可能 */
export const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';

/** ナレーター話者ID。既定は四国めたん（ノーマル） */
export const VOICEVOX_SPEAKER = Number(process.env.VOICEVOX_SPEAKER || 2);

/**
 * キュー（ナレーション区切り）同士の音声の最小間隔（秒）。
 * 前のキューの音声終了より早く次のキューの開始時刻が来た場合、この間隔を確保するよう
 * 後ろへずらす（assemble.mjs 参照）。
 */
export const MIN_CUE_GAP_SEC = 0.3;

/**
 * シーン開始から最初のキューが発声されるまでの「間（ま）」の最短秒数。
 * 画面が切り替わった直後にいきなり喋り出すと不自然なため、収録シーン側で
 * この秒数だけ待ってから ctx.cue(1) を呼ぶことを推奨する（scene のドキュメント参照）。
 */
export const SCENE_LEAD_IN_SEC = 0.8;

/**
 * 収録対象の拡張機能ビルドディレクトリを解決する。
 *
 * 移植元 sr-data-extraction-plugin/video の config.mjs と同じ設計をそのまま踏襲する
 * （あちらも tiab-review-plugin/video の `dist-demo/` 固定パスから、本関数と同じ優先順位の
 * 解決方式へ適応した経緯がある）。本拡張も現時点ではデモビルド層（dist-demo/）を持たない
 * ため、以下の優先順位で解決する。
 *   1. 環境変数 EXT_DIST_DIR （明示指定。存在しなければエラー）
 *   2. `<repo>/dist-demo`（存在すれば。デモビルドが後続 PR（video/REQUIREMENTS.md の PR2）で
 *      追加された場合に自動的にそちらを優先させるための布石）
 *   3. `<repo>/dist`（`npm run dev` / `npm run build` の出力。素のビルドで収録する）
 * いずれも見つからない場合は、`npm run dev` の実行を促す日本語エラーで例外を投げる。
 */
export function resolveExtensionDir() {
    const envDir = process.env.EXT_DIST_DIR;
    if (envDir) {
        if (!existsSync(envDir)) {
            throw new Error(
                `EXT_DIST_DIR に指定されたディレクトリが存在しません: ${envDir}\n` +
                '正しいパスを指定するか、環境変数を解除してください。',
            );
        }
        return envDir;
    }
    const distDemoDir = path.join(REPO_ROOT, 'dist-demo');
    if (existsSync(distDemoDir)) {
        return distDemoDir;
    }
    const distDir = path.join(REPO_ROOT, 'dist');
    if (existsSync(distDir)) {
        return distDir;
    }
    throw new Error(
        '収録対象の拡張機能ビルドが見つかりません。以下のいずれかを試してください。\n' +
        '  1. `npm run dev` を実行して dist/ を生成する（プロジェクト未選択状態での収録向け）\n' +
        '  2. デモビルド（dist-demo/）を用意する（後続 PR でのデモビルド層追加後）\n' +
        '  3. 環境変数 EXT_DIST_DIR で収録対象ディレクトリを明示する',
    );
}

/** Playwright 用 Chromium の実行ファイルパスを解決する */
export function resolveChromiumExecutable() {
    const envPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    if (envPath && existsSync(envPath)) {
        return envPath;
    }
    const defaultPath = '/opt/pw-browsers/chromium';
    if (existsSync(defaultPath)) {
        return defaultPath;
    }
    // どちらも無ければ undefined を返し、Playwright 既定の解決（開発機で
    // `npx playwright install chromium` 実行後に使われるパス）に委ねる。
    return undefined;
}

/**
 * env var → PATH 上のコマンド → エラー、の順で実行ファイルを解決する。
 * 見つからない場合は日本語の分かりやすいエラーメッセージで例外を投げる。
 */
function resolveExecutable(envVarName, commandName) {
    const envPath = process.env[envVarName];
    if (envPath) {
        if (!existsSync(envPath)) {
            throw new Error(
                `${envVarName} に指定されたパスが存在しません: ${envPath}\n` +
                `正しいパスを指定するか、環境変数を解除して PATH 上の ${commandName} を使ってください。`,
            );
        }
        return envPath;
    }
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const found = execFileSync(which, [commandName], { encoding: 'utf8' }).trim().split('\n')[0];
        if (found) {
            return found;
        }
    } catch {
        // PATH 上に見つからない場合は下のエラーへフォールスルー
    }
    throw new Error(
        `${commandName} が見つかりません。以下のいずれかで解決してください。\n` +
        `  1. 環境変数 ${envVarName} に ${commandName} の実行ファイルパスを設定する\n` +
        `  2. ${commandName} を PATH の通った場所にインストールする\n` +
        `  3. video/scripts/setup.sh を実行して video/tools/ 配下に自動セットアップする`,
    );
}

/** ffmpeg 実行ファイルのパスを解決する（呼び出し時に評価。存在しなければ例外） */
export function resolveFfmpeg() {
    return resolveExecutable('FFMPEG_PATH', 'ffmpeg');
}

/** ffprobe 実行ファイルのパスを解決する（呼び出し時に評価。存在しなければ例外） */
export function resolveFfprobe() {
    return resolveExecutable('FFPROBE_PATH', 'ffprobe');
}
