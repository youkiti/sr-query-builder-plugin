// ツアー検証の画像と辞書から、手順ごとの解説動画を生成する。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    REPO_ROOT, BUILD_DIR, VIDEO_WIDTH, VIDEO_HEIGHT, FPS,
    VOICEVOX_URL, VOICEVOX_SPEAKER, resolveChromiumExecutable,
} from './config.mjs';
import { ffmpeg } from './lib/ffmpeg.mjs';
import { readWavInfo } from './lib/wav.mjs';

export const DEFAULT_TOURS = ['getting-started', 'draft-and-optimize', 'expand-seeds', 'edit-and-export'];
/** 撮るときの画面の大きさ。通し検査の既定（1280x800）より広くし、サイドバーと本文が余裕をもって収まるようにする */
export const CAPTURE_SIZE = '1600x900';
// 画面の描画と、対象を画面内へ入れるスクロールが終わってから撮るために待つ。
export const CAPTURE_SETTLE_MS = 1500;
export const USAGE = '使い方: npm run video:tours -- [--skip-capture] [--silent] [--lang ja|en] [ツアーID ...]\n' +
    `ツアーID: ${DEFAULT_TOURS.join(', ')}\n--lang en には --silent が必要です。`;
const SHOTS_DIR = path.join(REPO_ROOT, '.tmp', 'guide-tour-check');
const OUT_DIR = path.join(BUILD_DIR, 'tours');

export function parseArgs(args) {
    const options = { skipCapture: false, silent: false, lang: 'ja', tourIds: [] };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--skip-capture') options.skipCapture = true;
        else if (arg === '--silent') options.silent = true;
        else if (arg === '--lang') {
            options.lang = args[++i];
            if (!['ja', 'en'].includes(options.lang)) throw new Error(`--lang は ja または en を指定してください。\n${USAGE}`);
        } else if (DEFAULT_TOURS.includes(arg)) {
            if (!options.tourIds.includes(arg)) options.tourIds.push(arg);
        } else throw new Error(`不明な引数: ${arg}\n${USAGE}`);
    }
    if (options.lang === 'en' && !options.silent) throw new Error(USAGE);
    if (!options.tourIds.length) options.tourIds = [...DEFAULT_TOURS];
    return options;
}

/** 単一引用符の文字列だけを解釈し、TypeScript のコードは実行しない。 */
export function parseDictionary(source) {
    const messages = {};
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', "'": "'", '"': '"', '\\': '\\' };
    for (const match of source.matchAll(/^\s*'(guide\.[^']+)':\s*'((?:\\.|[^'\\\r\n])*)',\s*(?:\/\/[^\r\n]*)?$/gm)) {
        messages[match[1]] = match[2].replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape) => {
            if (escape.startsWith('u{')) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
            if (/^[ux]/.test(escape) && escape.length > 1) return String.fromCodePoint(parseInt(escape.slice(1), 16));
            if (Object.hasOwn(escapes, escape)) return escapes[escape];
            throw new Error(`未対応の辞書エスケープ: \\${escape}`);
        });
    }
    if (!Object.keys(messages).length) throw new Error('guide. の辞書が 0 件です。辞書の行の形が変わっていないか確認してください。');
    return messages;
}

const pascalCase = id => id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
const keyBase = id => `guide.tour${pascalCase(id)}`;

export function pickShots(tourId, files, messages) {
    const prefix = `${keyBase(tourId)}Step`;
    const keys = Object.keys(messages).filter(key => key.startsWith(prefix));
    const pattern = new RegExp(`^${tourId}-(\\d+)-([a-z][a-z0-9-]*)\\.png$`);
    const candidates = files.map(file => {
        const match = file.match(pattern);
        return match && { file, seq: Number(match[1]), stepId: match[2], key: `${prefix}${pascalCase(match[2])}` };
    }).filter(Boolean).sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file));
    const seen = new Set();
    // 手順の並びは辞書（＝ツアーの定義）の順にする。撮影の連番順だと、別の周回で撮った手順（移動を促す手順など）が
    // 最後の手順より後ろに並んでしまう。同じ手順の画像が複数あるときは、連番が最も小さい 1 枚を使う。
    const shots = candidates.filter(shot => {
        if (!keys.includes(shot.key) || seen.has(shot.key)) return false;
        seen.add(shot.key);
        return true;
    }).sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
    if (!shots.length) throw new Error(`${tourId}: 手順の画像が 1 枚もありません。先に撮影してください。`);
    return { shots, missing: keys.filter(key => !seen.has(key)) };
}

// 音声だけに適用する（字幕・画面は原文のまま）。ja の文面に新しい英字・記号が入ったら追加する。
// 1 文字のキー名は、前後の語ごと登録して、登録のない英単語の一部を巻き込まないようにする。
export const READINGS = [
    ['ClinicalTrials.gov', 'クリニカルトライアルズ・ドット・ガブ'], ['Embase (Dialog)', 'エンベース（ダイアログ）'],
    ['Cochrane CENTRAL', 'コクラン・セントラル'], ['ICTRP', 'アイシーティーアールピー'],
    ['PMID', 'ピーエムアイディー'], ['PubMed', 'パブメド'], ['MeSH', 'メッシュ'], ['Markdown', 'マークダウン'],
    ['Word', 'ワード'], ['.docx', 'ドックス'], ['AND', 'アンド'], ['AI', 'エーアイ'], ['DB', 'ディービー'],
    ['include', 'インクルード'], ['exclude', 'エクスクルード'], ['maybe', 'メイビー'],
    ['i・e・m', 'アイ・イー・エム'], ['n で', 'エヌ で'], ['p で', 'ピー で'],
    ['Δ', 'デルタ'], ['①', 'いち、'], ['→', ''], ['/', '、'],
];

export function toReading(text, readings = READINGS) {
    for (const [from, to] of [...readings].sort((a, b) => b[0].length - a[0].length)) text = text.split(from).join(to);
    return text;
}

export function silentDuration(text, lang) {
    return Math.max(3, Array.from(text).length / (lang === 'en' ? 15 : 6));
}

/** 映像のフレーム境界に切り上げ、字幕と結合後の時刻の累積ずれを防ぐ。 */
export function frameDuration(seconds) { return Math.ceil(seconds * FPS) / FPS; }

export function srtTime(seconds) {
    const ms = Math.round(seconds * 1000);
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function makeTimeline(cues) {
    let frames = 0;
    const srt = [], chapters = [];
    for (const [i, cue] of cues.entries()) {
        const start = frames / FPS;
        frames += Math.round(cue.duration * FPS);
        srt.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(frames / FPS)}\n${cue.text}\n`);
        const sec = Math.floor(start);
        const time = sec >= 3600
            ? `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
            : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
        chapters.push(`${time} ${cue.chapter.replace(/\s+/g, ' ')}`);
    }
    return { srt: srt.join('\n'), chapters: chapters.join('\n') + '\n', duration: frames / FPS };
}

export function speakerNameFor(speakers, speakerId) {
    if (!Array.isArray(speakers) || speakers.some(speaker =>
        !speaker || typeof speaker.name !== 'string' || !speaker.name.trim() ||
        !Array.isArray(speaker.styles) || speaker.styles.some(style => !style || !Number.isInteger(style.id)))) {
        throw new Error('VOICEVOX /speakers: 応答の形式が不正です。');
    }
    const speaker = speakers.find(speaker => speaker.styles.some(style => style.id === speakerId));
    if (!speaker) throw new Error(`VOICEVOX /speakers: 話者 ID ${speakerId} に一致する話者が見つかりません。`);
    return speaker.name;
}

export function makeChaptersText(chapters, { silent, speakerName }) {
    if (silent) return chapters;
    if (typeof speakerName !== 'string' || !speakerName.trim()) throw new Error('VOICEVOX のクレジットに必要な話者名がありません。');
    return `${chapters.trimEnd()}\n\nナレーション: VOICEVOX:${speakerName}\n`;
}

const escapeHtml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function frameHtml({ title, text, image, number, lang }, tokens) {
    return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>
    ${tokens}
    *{box-sizing:border-box} body{margin:0;width:${VIDEO_WIDTH}px;height:${VIDEO_HEIGHT}px;background:var(--color-bg);color:var(--color-text);font-family:var(--font-family-sans)}
    main{height:100%;padding:24px 64px;display:flex;flex-direction:column;gap:20px}
    img{width:100%;height:800px;object-fit:contain;flex:none}
    section{flex:1;min-height:0} h1{font-size:32px;color:var(--color-primary);margin:0 0 12px}
    p{font-size:32px;line-height:1.5;white-space:pre-wrap;margin:0;overflow-wrap:anywhere}
    .number{float:right;color:var(--color-text-muted)}
    .intro{justify-content:center;padding:120px}.intro section{flex:none}.intro h1{font-size:72px}.intro p{font-size:44px}
    </style><body><main class="${image ? '' : 'intro'}">
    ${image ? `<img alt="" src="data:image/png;base64,${image}">` : ''}
    <section><h1>${number ? `<span class="number">${number}</span>` : ''}${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></section>
    </main></body></html>`;
}

async function stage(id, name, step, command, action) {
    const context = `[${id} / ${step}] ${name}`;
    console.log(`${context}: 開始 (${command})`);
    try {
        const result = await action();
        console.log(`${context}: 完了`);
        return result;
    } catch (error) {
        throw new Error(`${context}: 失敗\nコマンド: ${command}\n出力: ${error.stack || error}`, { cause: error });
    }
}

export function captureArgs(id, lang) {
    return ['tools/guide-tour-check/run.mjs', '--only', id, '--lang', lang,
        '--size', CAPTURE_SIZE, '--settle', String(CAPTURE_SETTLE_MS)];
}

function runCapture(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
            output += data.toString();
            process.stdout.write(data);
        });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`終了コード ${code}\n${output}`)));
    });
}

export async function requestVoice(endpoint, options = {}, fetchVoice = fetch) {
    let response;
    try {
        response = await fetchVoice(`${VOICEVOX_URL}${endpoint}`, { ...options, signal: AbortSignal.timeout(60000) });
    } catch (error) {
        throw new Error(`VOICEVOX が起動していない。起動するか --silent を付ける。\n${endpoint.split('?')[0]}: ${error.message}`);
    }
    if (!response.ok) throw new Error(`VOICEVOX ${endpoint.split('?')[0]}: HTTP ${response.status}\n${await response.text()}`);
    return response;
}

async function audioFor(text, workDir) {
    const spoken = toReading(text);
    const hash = createHash('sha256').update(JSON.stringify([VOICEVOX_SPEAKER, spoken])).digest('hex');
    const file = path.join(workDir, `voice-${hash}.wav`);
    if (!existsSync(file)) {
        const query = await (await requestVoice(`/audio_query?speaker=${VOICEVOX_SPEAKER}&text=${encodeURIComponent(spoken)}`, { method: 'POST' })).json();
        const response = await requestVoice(`/synthesis?speaker=${VOICEVOX_SPEAKER}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
        });
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    } else console.log('音声: 同じ文言・話者のキャッシュを再利用');
    return { file, duration: readWavInfo(file).durationSec };
}

async function buildTour(id, options, messages) {
    const workDir = path.join(OUT_DIR, id);
    const archive = path.join(workDir, `capture-${options.lang}`);
    const manifest = path.join(archive, 'files.json');
    const marker = path.join(SHOTS_DIR, `${id}-video-language.json`);
    mkdirSync(workDir, { recursive: true });
    let sourceDir = SHOTS_DIR, files;
    if (!options.skipCapture) {
        const args = captureArgs(id, options.lang);
        await stage(id, '撮る', '全手順', JSON.stringify([process.execPath, ...args]), async () => {
            mkdirSync(SHOTS_DIR, { recursive: true });
            // 前回だけ通った手順を混ぜないよう、このシナリオの画像のみ除く。
            for (const file of readdirSync(SHOTS_DIR)) {
                if (new RegExp(`^${id}-\\d+-.*\\.png$`).test(file)) unlinkSync(path.join(SHOTS_DIR, file));
            }
            writeFileSync(marker, JSON.stringify({ lang: options.lang, complete: false }));
            await runCapture(args);
            files = readdirSync(SHOTS_DIR).filter(file => new RegExp(`^${id}-\\d+-.*\\.png$`).test(file));
            mkdirSync(archive, { recursive: true });
            for (const file of files) copyFileSync(path.join(SHOTS_DIR, file), path.join(archive, file));
            writeFileSync(manifest, JSON.stringify(files));
            writeFileSync(marker, JSON.stringify({ lang: options.lang, complete: true }));
            sourceDir = archive;
        });
    } else {
        console.log(`[${id} / 全手順] 撮る: 省略 (--skip-capture)`);
        await stage(id, '画像を選ぶ', '撮影記録', `撮影記録を読む ${archive}`, () => {
            if (existsSync(manifest)) {
                sourceDir = archive;
                files = JSON.parse(readFileSync(manifest, 'utf8'));
            } else {
                const provenance = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
                if (provenance ? provenance.lang !== options.lang || !provenance.complete : options.lang !== 'ja') {
                    throw new Error(`${options.lang} の撮影記録がありません。--skip-capture を外して撮影してください。`);
                }
                console.log(`[${id}] 画像を選ぶ: 既存の画像を使用（言語記録のない画像は日本語として扱います）`);
                files = existsSync(SHOTS_DIR) ? readdirSync(SHOTS_DIR) : [];
            }
        });
    }
    const { shots, missing } = await stage(id, '画像を選ぶ', '全手順', `辞書照合 ${sourceDir}`, () => pickShots(id, files, messages));
    for (const key of missing) console.warn(`[${id}] 警告: 画像のない手順（シナリオで未通過）: ${key}`);
    console.log(`[${id}] 画像を選ぶ: ${shots.length} 手順を採用`);
    const title = messages[`${keyBase(id)}Title`], description = messages[`${keyBase(id)}Desc`];
    if (!title || !description) throw new Error(`${id}: 辞書の Title / Desc がありません。`);
    const cues = [{ stepId: 'intro', text: description, subtitle: `${title}\n${description}`, chapter: title }];
    shots.forEach((shot, i) => cues.push({ ...shot, text: messages[shot.key], subtitle: messages[shot.key], chapter: messages[shot.key], number: `${i + 1} / ${shots.length}` }));
    const suffix = `${options.lang === 'en' ? '-en' : ''}${options.silent ? '-silent' : ''}`;
    const variantDir = path.join(workDir, `${options.lang}${options.silent ? '-silent' : '-voice'}`);
    mkdirSync(variantDir, { recursive: true });
    const tokens = readFileSync(path.join(REPO_ROOT, 'src/styles/tokens.css'), 'utf8');
    const browser = await stage(id, '画面を作る', '準備', 'chromium.launch(headless)', async () => {
        const { chromium } = await import('playwright');
        return chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true });
    });
    const segments = [];
    try {
        const page = await stage(id, '画面を作る', '準備', 'browser.newPage(1920x1080)', () =>
            browser.newPage({ viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, deviceScaleFactor: 1 }));
        for (const [i, cue] of cues.entries()) {
            const frame = path.join(variantDir, `${i}-${cue.stepId}.png`);
            await stage(id, '画面を作る', cue.stepId, `Playwright setContent / screenshot ${frame}`, async () => {
                await page.setContent(frameHtml({ title, text: cue.text, number: cue.number, lang: options.lang,
                    image: cue.file ? readFileSync(path.join(sourceDir, cue.file)).toString('base64') : null }, tokens));
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await Promise.all([...document.images].map(img => img.decode()));
                    const section = document.querySelector('section');
                    // 英語の文面は日本語より長い手順があるので、はみ出すときだけ文字を小さくして収める（下限 22px）。
                    const paragraph = section.querySelector('p');
                    let size = parseFloat(getComputedStyle(paragraph).fontSize);
                    while (section.scrollHeight > section.clientHeight && size > 22) {
                        size -= 2;
                        paragraph.style.fontSize = `${size}px`;
                    }
                    if (section.scrollHeight > section.clientHeight) throw new Error('文言が画面からはみ出しています');
                });
                await page.screenshot({ path: frame });
            });
            const audio = await stage(id, '音声', cue.stepId, options.silent ? '無音の尺を計算' : 'VOICEVOX POST /audio_query → /synthesis（キャッシュ可）', async () => {
                if (options.silent) return null;
                return audioFor(cue.subtitle, workDir);
            });
            cue.duration = frameDuration(audio ? audio.duration + 0.5 + 0.9 : silentDuration(cue.subtitle, options.lang));
            const segment = path.join(variantDir, `seg-${i}.mp4`);
            const args = ['-loop', '1', '-framerate', String(FPS), '-i', frame,
                ...(audio ? ['-i', audio.file, '-filter_complex', '[1:a]adelay=500:all=1,apad[a]', '-map', '0:v', '-map', '[a]']
                    : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a']),
                '-t', cue.duration.toFixed(6), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
                '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-ar', '48000', '-ac', '2', segment];
            await stage(id, 'つなぐ', cue.stepId, JSON.stringify(['ffmpeg', '-y', ...args]), () => ffmpeg(args));
            segments.push(segment);
        }
    } finally {
        await stage(id, '画面を作る', '終了処理', 'browser.close()', () => browser.close());
    }
    const list = path.join(variantDir, 'segments.txt');
    writeFileSync(list, segments.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const output = path.join(OUT_DIR, `${id}${suffix}`);
    const args = ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', `${output}.mp4`];
    await stage(id, 'つなぐ', '全手順', JSON.stringify(['ffmpeg', '-y', ...args]), async () => {
        await ffmpeg(args);
        const timeline = makeTimeline(cues.map(cue => ({ ...cue, text: cue.subtitle })));
        writeFileSync(`${output}.srt`, timeline.srt);
        writeFileSync(`${output}-chapters.txt`, makeChaptersText(timeline.chapters, options));
        console.log(`[${id}] 出力: ${output}.mp4 / .srt / -chapters.txt（${timeline.duration.toFixed(1)} 秒）`);
    });
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    const messages = parseDictionary(readFileSync(path.join(REPO_ROOT, `src/lib/i18n/${options.lang}.ts`), 'utf8'));
    if (!options.silent) {
        await stage(options.tourIds.join(', '), '音声', '事前確認', 'VOICEVOX GET /version', () => requestVoice('/version'));
        options.speakerName = await stage(options.tourIds.join(', '), '音声', 'クレジット確認', 'VOICEVOX GET /speakers', async () =>
            speakerNameFor(await (await requestVoice('/speakers')).json(), VOICEVOX_SPEAKER));
    }
    for (const id of options.tourIds) await buildTour(id, options, messages);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
