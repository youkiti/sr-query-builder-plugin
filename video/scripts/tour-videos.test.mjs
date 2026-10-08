// ブラウザ・ffmpeg・実 API を起動せず、動画生成の入力と時刻計算を検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DEFAULT_TOURS, parseArgs, captureArgs, parseDictionary, pickShots, READINGS, toReading,
    silentDuration, frameDuration, srtTime, makeTimeline, frameHtml, requestVoice,
    speakerNameFor, makeChaptersText, main,
} from './tour-videos.mjs';

test('撮影引数: 画面サイズと描画を待つ時間を指定する', () => {
    for (const lang of ['ja', 'en']) {
        assert.deepEqual(captureArgs('getting-started', lang), [
            'tools/guide-tour-check/run.mjs', '--only', 'getting-started', '--lang', lang,
            '--size', '1600x900', '--settle', '1500',
        ]);
    }
});

test('引数: 既定の5本、IDの指定、オプションの順序と重複', () => {
    assert.deepEqual(parseArgs([]), { skipCapture: false, silent: false, lang: 'ja', tourIds: DEFAULT_TOURS });
    assert.deepEqual(parseArgs(['getting-started', '--skip-capture', '--silent', '--lang', 'en', 'edit-and-export', 'getting-started']), {
        skipCapture: true, silent: true, lang: 'en', tourIds: ['getting-started', 'edit-and-export'],
    });
    assert.equal(parseArgs(['--lang', 'ja']).lang, 'ja');
    assert.equal(parseArgs(['--skip-capture']).skipCapture, true);
    assert.equal(parseArgs(['--silent']).silent, true);
});

test('引数: 不明なオプション・ID・言語・英語の読み上げは使い方付きで拒否', () => {
    for (const args of [['--unknown'], ['missing'], ['getting-started-extra'], ['--lang'],
        ['--lang', 'fr'], ['--lang', '--silent'], ['--lang', 'en']]) {
        assert.throws(() => parseArgs(args), /使い方:/);
    }
});

test('辞書: guide. の単一引用符行を読み、引用符・改行・Unicode等を復元', () => {
    const source = String.raw`
      'guide.sample': 'It\'s \\test\nnext\t\"quoted\"\r\b\f\v\0',
      'other.sample': '対象外',
      'guide.unicode': '\u65e5\u{1F600}\x41', // コメント
    `;
    assert.deepEqual(parseDictionary(source), {
        'guide.sample': 'It\'s \\test\nnext\t"quoted"\r\b\f\v\0',
        'guide.unicode': '日😀A',
    });
    assert.throws(() => parseDictionary("'other.key': '無視',"), /0 件/);
    assert.throws(() => parseDictionary('"guide.key": "形式変更",'), /0 件/);
    assert.throws(() => parseDictionary(String.raw`'guide.key': '\q',`), /未対応/);
});

const messages = {
    'guide.tourGettingStartedTitle': '題',
    'guide.tourGettingStartedDesc': '説明',
    'guide.tourGettingStartedStepOpenProtocol': '開く',
    'guide.tourGettingStartedStepEnterProtocol': '読む',
    'guide.tourGettingStartedStepFinish': '終える',
};

test('画像: 辞書（ツアー定義）の順に並べ、手順ごとに連番が最小の1枚、補助画像は除く', () => {
    const { shots, missing } = pickShots('getting-started', [
        'getting-started-10-open-protocol.png', 'getting-started-2-enter-protocol.png',
        'getting-started-11-enter-protocol.png', 'getting-started-1-enter-protocol-blocked-mouse.png',
        'getting-started-3-done.png', 'getting-started-12-open-protocol.png', 'getting-started-4-FAIL-open-protocol.png',
        'getting-started-5-blocked-keyboard.png', 'export-data-1-finish.png',
        'getting-started-6-unknown.png', 'getting-started-7-finish.jpg',
    ], messages);
    assert.deepEqual(shots.map(shot => [shot.seq, shot.stepId]), [[10, 'open-protocol'], [2, 'enter-protocol']]);
    assert.deepEqual(missing, ['guide.tourGettingStartedStepFinish']);
    assert.throws(() => pickShots('getting-started', [], messages), /1 枚も/);
    assert.throws(() => pickShots('getting-started', ['getting-started-1-done.png'], messages), /1 枚も/);
});

test('読み替え: 長い語を先に適用し、辞書・字幕は変更しない', () => {
    assert.equal(toReading('AI AND PMID / → Δ ①'), 'エーアイ アンド ピーエムアイディー 、  デルタ いち、');
    assert.equal(toReading('i・e・m で判定、n で次へ、p で前へ'), 'アイ・イー・エム で判定、エヌ で次へ、ピー で前へ');
    assert.equal(toReading('ABC A', [['A', '短'], ['ABC', '長']]), '長 短');
    const text = 'AI と PMID';
    const spoken = toReading(text);
    assert.equal(spoken, 'エーアイ と ピーエムアイディー');
    assert.match(makeTimeline([{ text, chapter: text, duration: 3 }]).srt, /AI と PMID/);
    assert.equal(text, 'AI と PMID');
});

// 読み替え後に残ってよい文字: 日本語（ひらがな・カタカナ・漢字・長音・繰り返し）、数字、空白、日本語の句読点と括弧。
const READABLE_CHARS = '\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}ー々0-9\\s、。「」・（）';
const READABLE = new RegExp(`^[${READABLE_CHARS}]*$`, 'u');
const leftover = text => text.replace(new RegExp(`[${READABLE_CHARS}]+`, 'gu'), ' ').trim();

test('現在の日英辞書: 全ツアーに題・説明・手順があり、日本語の文面は読み替え後に英字・特殊記号が残らない', () => {
    const used = new Set();
    for (const lang of ['ja', 'en']) {
        const dictionary = parseDictionary(readFileSync(new URL(`../../src/lib/i18n/${lang}.ts`, import.meta.url), 'utf8'));
        for (const id of DEFAULT_TOURS) {
            const base = 'guide.tour' + id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join('');
            assert.ok(dictionary[`${base}Title`]);
            assert.ok(dictionary[`${base}Desc`]);
            const entries = Object.entries(dictionary).filter(([key]) => key.startsWith(base));
            assert.ok(entries.some(([key]) => key.startsWith(`${base}Step`)));
            if (lang !== 'ja') continue;
            for (const [key, text] of entries) {
                // 残るなら READINGS の登録漏れ。残った文字を示して失敗させる。
                assert.match(toReading(text), READABLE, `${key}: 読み替え後に英字・記号が残っています: ${leftover(toReading(text))}`);
                for (const [from] of READINGS) if (text.includes(from)) used.add(from);
            }
        }
    }
    assert.equal(new Set(READINGS.map(([from]) => from)).size, READINGS.length);
    // ja の文面に出てこない登録は、文面を変えたあとに残った死んだ登録。
    assert.deepEqual(READINGS.map(([from]) => from).filter(from => !used.has(from)), []);
});

test('無音の尺: 日本語6文字/秒、英語15文字/秒、最短3秒', () => {
    assert.equal(silentDuration('', 'ja'), 3);
    assert.equal(silentDuration('短い', 'ja'), 3);
    assert.equal(silentDuration('あ'.repeat(60), 'ja'), 10);
    assert.equal(silentDuration('a'.repeat(60), 'en'), 4);
    assert.equal(silentDuration('😀'.repeat(24), 'ja'), 4);
    assert.equal(frameDuration(3.01), 91 / 30);
});

test('字幕と章: 全画面の開始・終了を累積し、分・時の境界も正しく表示', () => {
    const timeline = makeTimeline([
        { text: '題\n説明', chapter: '題', duration: 3 },
        { text: '手順1', chapter: '手順1', duration: 57 },
        { text: '手順2', chapter: '手順2', duration: 3540 },
        { text: '手順3', chapter: '長い\n文言', duration: 3 },
    ]);
    assert.equal(timeline.duration, 3603);
    assert.equal(timeline.chapters, '0:00 題\n0:03 手順1\n1:00 手順2\n1:00:00 長い 文言\n');
    assert.equal(timeline.srt, '1\n00:00:00,000 --> 00:00:03,000\n題\n説明\n\n' +
        '2\n00:00:03,000 --> 00:01:00,000\n手順1\n\n' +
        '3\n00:01:00,000 --> 01:00:00,000\n手順2\n\n' +
        '4\n01:00:00,000 --> 01:00:03,000\n手順3\n');
    assert.equal(srtTime(59.9996), '00:01:00,000');
    assert.equal(srtTime(1 / 30), '00:00:00,033');
    const frames = makeTimeline(Array.from({ length: 30 }, () => ({ text: 'a', chapter: 'a', duration: 91 / 30 })));
    assert.equal(frames.duration, 91);
});

test('話者名: 複数の話者・スタイルから合成に使う ID を探す', () => {
    const speakers = [
        { name: '四国めたん', styles: [{ id: 0 }, { id: 2 }] },
        { name: 'ずんだもん', styles: [{ id: 1 }, { id: 3 }] },
    ];
    assert.equal(speakerNameFor(speakers, 2), '四国めたん');
    assert.equal(speakerNameFor(speakers, 3), 'ずんだもん');
    assert.throws(() => speakerNameFor(speakers, 99), /話者 ID 99 に一致する話者が見つかりません/);
    assert.throws(() => speakerNameFor([], 2), /一致する話者が見つかりません/);
});

test('話者名: 応答の形が違えば理由を出して拒否する', () => {
    for (const speakers of [null, {}, '不正', [null], [{}],
        [{ name: '', styles: [] }], [{ name: 123, styles: [] }],
        [{ name: '四国めたん', styles: {} }],
        [{ name: '四国めたん', styles: [null] }],
        [{ name: '四国めたん', styles: [{ id: '2' }] }]]) {
        assert.throws(() => speakerNameFor(speakers, 2), /応答の形式が不正/);
    }
});

test('章の一覧: 読み上げ時だけ空行と話者のクレジットを末尾に付ける', () => {
    const chapters = makeTimeline([{ text: '説明', chapter: '題', duration: 3 }]).chapters;
    for (const speakerName of ['四国めたん', 'ずんだもん']) {
        assert.equal(makeChaptersText(chapters, { ...parseArgs([]), speakerName }),
            `0:00 題\n\nナレーション: VOICEVOX:${speakerName}\n`);
    }
    assert.equal(makeChaptersText(chapters, parseArgs(['--silent'])), chapters);
    assert.throws(() => makeChaptersText(chapters, parseArgs([])), /話者名がありません/);
});

test('事前確認: 話者情報の取得失敗・不一致では動画生成へ進まない（実通信なし）', async t => {
    for (const failure of ['http', 'network', 'missing', 'invalid']) {
        const endpoints = [];
        const mocked = t.mock.method(globalThis, 'fetch', async url => {
            const endpoint = new URL(url).pathname;
            endpoints.push(endpoint);
            if (endpoint === '/version') return { ok: true };
            if (failure === 'network') throw new Error('ECONNREFUSED');
            if (failure === 'http') return { ok: false, status: 500, text: async () => '取得エラー' };
            return { ok: true, json: async () => failure === 'missing' ? [] : {} };
        });
        try {
            await assert.rejects(main(['getting-started']), /\/speakers/);
            assert.deepEqual(endpoints, ['/version', '/speakers']);
        } finally {
            mocked.mock.restore();
        }
    }
});

test('画面HTML: 原文をエスケープし、画像・手順番号・アプリのトークンを配置', () => {
    const html = frameHtml({ title: 'AI & PDF', text: '<script>"引用"</script>', image: 'AAAA', number: '1 / 2', lang: 'en' }, ':root{--color-bg:#f7f8f8}');
    assert.match(html, /lang="en"/);
    assert.match(html, /AI &amp; PDF/);
    assert.match(html, /&lt;script&gt;&quot;引用&quot;&lt;\/script&gt;/);
    assert.match(html, /data:image\/png;base64,AAAA/);
    assert.match(html, /1 \/ 2/);
    assert.match(html, /--color-bg:#f7f8f8/);
    const intro = frameHtml({ title: '題', text: '説明', lang: 'ja' }, '');
    assert.match(intro, /class="intro"/);
    assert.doesNotMatch(intro, /<img/);
});

test('VOICEVOX: 接続不能を明示し、HTTP失敗の出力も残す（実通信なし）', async () => {
    await assert.rejects(requestVoice('/version', {}, async () => { throw new Error('ECONNREFUSED'); }),
        /VOICEVOX が起動していない。起動するか --silent を付ける。\n\/version: ECONNREFUSED/);
    await assert.rejects(requestVoice('/audio_query', {}, async () => ({ ok: false, status: 500, text: async () => '合成エラー' })),
        /HTTP 500\n合成エラー/);
    const response = { ok: true };
    assert.equal(await requestVoice('/version', {}, async () => response), response);
});
