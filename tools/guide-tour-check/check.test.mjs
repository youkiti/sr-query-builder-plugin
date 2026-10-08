import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from './lib/options.mjs';
import { defineScenario, selectScenarios } from './lib/scenario.mjs';
import { executeScenarios, summarize } from './lib/results.mjs';
import { resolveDemoDir } from './lib/paths.mjs';
import { Run } from './lib/run.mjs';
import { withFreshBrowser, stopProfileProcesses } from './lib/browser.mjs';

test('終了待ちと後始末はシナリオの成否を変えず、対象プロファイルだけを渡す', async () => {
    for (const mode of ['normal', 'timeout', 'scenario-failure', 'stop-failure', 'remove-failure', 'close-failure']) {
        const messages = [];
        const stopped = [];
        let profile;
        const failure = new Error('シナリオの元の失敗');
        try {
            const result = withFreshBrowser({ name: 'sample', run: async () => {
                if (mode === 'scenario-failure') throw failure;
            } }, parseArgs([]), 'fake-demo', [], {
                launch: async directory => {
                    profile = directory;
                    return {
                        serviceWorkers: () => [{ url: () => 'chrome-extension://fake/worker.js' }],
                        newPage: async () => ({ setDefaultTimeout() {} }),
                        close: () => {
                            if (mode === 'close-failure') throw new Error('終了失敗');
                            return mode === 'normal' ? Promise.resolve() : new Promise(() => {});
                        },
                    };
                },
                closeTimeoutMs: 5,
                warn: message => messages.push(message),
                stopProcesses: directory => {
                    stopped.push(directory);
                    if (mode === 'stop-failure') throw new Error('停止失敗');
                },
                removeProfile: (directory, options) => {
                    assert.equal(directory, profile);
                    assert.deepEqual(options, { recursive: true, force: true });
                    if (mode === 'remove-failure') throw Object.assign(new Error('削除失敗'), { code: 'EPERM' });
                    rmSync(directory, options);
                },
            });
            if (mode === 'scenario-failure') await assert.rejects(result, error => error === failure);
            else await result;
            assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
            assert.ok(path.basename(profile).startsWith('sr-tour-check-'));
            if (mode === 'normal') {
                assert.deepEqual(messages, []);
                assert.deepEqual(stopped, []);
            } else if (mode === 'close-failure') {
                assert.deepEqual(stopped, []);
                assert.match(messages[0], /sample: ブラウザの終了に失敗/);
            } else {
                assert.deepEqual(stopped, [profile]);
                assert.match(messages[0], /sample: ブラウザの終了が 0.005 秒以内に戻らなかった/);
                assert.equal(messages.length, ['stop-failure', 'remove-failure'].includes(mode) ? 2 : 1);
            }
            assert.equal(existsSync(profile), mode === 'remove-failure');
        } finally {
            if (profile) rmSync(profile, { recursive: true, force: true });
        }
    }
});

test('Windows は専用プロファイルのパスを含む PID だけを停止する', () => {
    const profile = "C:\\Temp\\記号 ' $ & [x]\\sr-tour-check-abc";
    const calls = [];
    const messages = [];
    stopProfileProcesses(profile, message => messages.push(message), {
        platform: 'win32',
        execute: (file, args, options) => {
            calls.push({ file, args, options });
            if (calls.length === 1) return JSON.stringify([
                { ProcessId: 11, CommandLine: `chrome --user-data-dir="${profile}"` },
                { ProcessId: 12, CommandLine: 'chrome --user-data-dir=C:\\Users\\Default' },
                { ProcessId: 13, CommandLine: 'chrome --user-data-dir=C:\\Temp\\sr-tour-check-other' },
                { ProcessId: 14, CommandLine: null },
                { ProcessId: 15, CommandLine: `renderer ${profile}` },
            ]);
            return '';
        },
    });
    assert.equal(calls.length, 3);
    assert.match(calls[0].args.at(-1), /Get-CimInstance Win32_Process/);
    assert.match(calls[1].args.at(-1), /Stop-Process -Id 11 -Force/);
    assert.match(calls[2].args.at(-1), /Stop-Process -Id 15 -Force/);
    for (const call of calls) {
        assert.equal(call.file, 'powershell.exe');
        assert.ok(!call.args.join(' ').includes(profile));
        assert.equal(call.options.timeout, 5000);
    }
    assert.deepEqual(messages, []);
});

test('プロセス一覧の取得・解析・停止の失敗は警告だけにし、残りの停止を続ける', () => {
    for (const mode of ['list', 'parse', 'stop']) {
        const messages = [];
        let calls = 0;
        assert.doesNotThrow(() => stopProfileProcesses('profile', message => messages.push(message), {
            platform: 'win32', execute: () => {
                calls++;
                if (mode === 'parse') return 'invalid json';
                if (mode === 'list' || calls > 1) throw new Error('実行失敗');
                return JSON.stringify([11, 12].map(ProcessId => ({ ProcessId, CommandLine: 'profile' })));
            },
        }));
        assert.equal(messages.length, mode === 'stop' ? 2 : 1);
        assert.equal(calls, mode === 'stop' ? 3 : 1);
    }
});

test('Windows 以外ではパスを正規表現としてエスケープして引数に渡す', () => {
    const profile = "/tmp/space ' $ & [x]/sr-tour-check-a.b";
    const messages = [];
    stopProfileProcesses(profile, message => messages.push(message), {
        platform: 'linux', execute: (file, args) => {
            assert.equal(file, 'pkill');
            assert.equal(args[0], '-f');
            const pattern = new RegExp(args[1]);
            assert.ok(pattern.test(`chrome --user-data-dir=${profile}`));
            assert.ok(!pattern.test(profile.replace('a.b', 'axb')));
            assert.ok(!pattern.test('/tmp/sr-tour-check-other'));
        },
    });
    for (const error of [{ code: 'ENOENT' }, { status: 1 }, { status: 2 }]) {
        assert.doesNotThrow(() => stopProfileProcesses(profile, message => messages.push(message), {
            platform: 'linux', execute: () => { throw error; },
        }));
    }
    assert.equal(messages.length, 1);
});

test('引数の既定値と明示指定', () => {
    assert.deepEqual(parseArgs([]), { only: null, lang: 'ja', size: { width: 1280, height: 800 }, settle: 0 });
    assert.deepEqual(parseArgs(['--lang', 'en', '--size', '400x700', '--only', 'getting-started', '--settle', '1500']), {
        only: 'getting-started', lang: 'en', size: { width: 400, height: 700 }, settle: 1500,
    });
    for (const value of ['0', '10000']) assert.equal(parseArgs(['--settle', value]).settle, Number(value));
});

test('撮影前の待ち時間は欠落・範囲外・整数以外を拒否する', () => {
    for (const args of [['--settle'], ['--settle', '--lang', 'ja'],
        ...['', '-1', '10001', '1.5', 'NaN', 'Infinity', 'abc', '1e3', '0x10', ' 1', '99999999999999999999']
            .map(value => ['--settle', value])]) {
        assert.throws(() => parseArgs(args), /--settle/, args.join(' '));
    }
});

test('手順画像だけ指定時間を待ち、既定値・失敗・完了画像は待たない', async () => {
    const calls = [];
    const page = {
        locator: () => ({ waitFor: async () => {}, evaluateAll: async () => [] }),
        waitForFunction: async () => {}, evaluate: async () => false,
        waitForTimeout: async ms => calls.push(['wait', ms]),
        screenshot: async ({ path }) => calls.push(['shot', path.split(/[\\/]/).at(-1)]),
        url: () => 'chrome-extension://fake/app/app.html',
    };
    const run = new Run('sample', page, 'fake', 'ja', 'fake-demo', []);
    await run.step('first', 'target');
    assert.deepEqual(calls, [['shot', 'sample-01-first.png']]);
    calls.length = 0;
    run.settle = 1500;
    await run.step('second', 'target');
    await assert.rejects(run.action('失敗時の撮影', async () => { throw new Error('失敗'); }), /失敗/);
    await run.shot('done');
    assert.deepEqual(calls, [
        ['wait', 1500], ['shot', 'sample-02-second.png'], ['shot', 'sample-03-FAIL-second.png'],
        ['shot', 'sample-04-done.png'],
    ]);
});

test('待機のまま撮った手順は、理由つきの警告として集計に残る', async () => {
    const calls = [];
    const warnings = [];
    const page = {
        locator: () => ({ waitFor: async () => {}, evaluateAll: async () => [] }),
        waitForTimeout: async ms => calls.push(['wait', ms]),
        screenshot: async ({ path }) => calls.push(['shot', path.split(/[\\/]/).at(-1)]),
        url: () => 'chrome-extension://fake/app/app.html',
    };
    const run = new Run('sample', page, 'fake', 'ja', 'fake-demo', warnings);
    run.settle = 700;
    await run.waitingStep('held', '保留候補が出ない');
    assert.deepEqual(calls, [['wait', 700], ['shot', 'sample-01-held.png']]);
    assert.deepEqual(warnings, ['sample / held: 待機の状態で撮影しました（保留候補が出ない）']);
});

test('値の欠落・不正な言語・サイズ・パス・未知の引数は拒否する', () => {
    for (const args of [
        ['--only'], ['--lang'], ['--size'], ['--only', '--lang', 'en'], ['--lang', 'fr'],
        ['--size', '0x800'], ['--size', '-1x800'], ['--size', '800.5x600'],
        ['--size', '99999999999999999999x800'], ['--size', '800X600'], ['--only', '../a'], ['--unknown'],
    ]) assert.throws(() => parseArgs(args), undefined, args.join(' '));
});

test('シナリオの必須項目・名前・重複を検査する', () => {
    const valid = { name: 'sample', title: '検証', run() {} };
    assert.equal(defineScenario(valid), valid);
    for (const value of [null, {}, { ...valid, name: '../x' }, { ...valid, title: '' }, { ...valid, run: null }]) {
        assert.throws(() => defineScenario(value));
    }
    assert.deepEqual(selectScenarios([valid], null), [valid]);
    assert.deepEqual(selectScenarios([valid], 'sample'), [valid]);
    assert.throws(() => selectScenarios([valid], 'missing'));
    assert.throws(() => selectScenarios([], null));
    assert.throws(() => selectScenarios([valid, valid], null));
});

test('実シナリオはファイル名と定義が一致し、ツアーと同じ 4 本とも選択できる', async () => {
    const directory = new URL('./scenarios/', import.meta.url);
    const scenarios = [];
    for (const file of readdirSync(directory).filter(f => f.endsWith('.mjs'))) {
        const scenario = defineScenario((await import(new URL(file, directory).href)).default);
        assert.equal(`${scenario.name}.mjs`, file);
        scenarios.push(scenario);
    }
    assert.deepEqual(selectScenarios(scenarios, null).map(s => s.name).sort(), [
        'draft-and-optimize', 'edit-and-export', 'expand-seeds', 'getting-started',
    ]);
});

test('失敗後も次を実行し、警告を保持して非ゼロ終了にする', async () => {
    const calls = [];
    const results = await executeScenarios([{ name: 'first' }, { name: 'second' }], async (scenario, warnings) => {
        calls.push(scenario.name);
        warnings.push('対象を覆っています');
        if (scenario.name === 'first') throw new Error('手順 import: 文献を待っています');
    });
    assert.deepEqual(calls, ['first', 'second']);
    assert.deepEqual(results.map(r => r.ok), [false, true]);
    const summary = summarize(results);
    assert.equal(summary.exitCode, 1);
    assert.match(summary.text, /手順 import/);
    assert.match(summary.text, /警告: 対象を覆っています/);
    assert.match(summary.text, /成功: second/);
    assert.equal(summarize(results.slice(1)).exitCode, 0);
    assert.equal(summarize([]).exitCode, 1);
});

test('デモビルドが無ければビルドを促す', () => {
    assert.throws(() => resolveDemoDir({ EXT_DIST_DIR: 'tools/guide-tour-check/nonexistent-demo' }), /npm run build:demo/);
});

test('待ちの失敗にシナリオ・手順・条件・カード属性・URL・画像を残す', async () => {
    const page = {
        locator: () => ({ evaluateAll: async () => [{ step: 'enter-protocol', waiting: 'true' }] }),
        url: () => 'chrome-extension://fake/app/app.html?demoSeed=04-protocol#/protocol',
    };
    const run = new Run('getting-started', page, 'fake', 'ja', 'fake-demo', []);
    run.stepId = 'open-blocks';
    run.shot = async label => `${label}.png`;
    await assert.rejects(() => run.action('承認ボタンが表示される', async () => { throw new Error('待ち時間切れ'); }), error => {
        for (const text of ['getting-started', 'open-blocks', '承認ボタンが表示される', 'enter-protocol',
            'data-guide-step', 'data-guide-waiting', 'true', page.url(), 'FAIL-open-blocks.png', '待ち時間切れ']) {
            assert.ok(error.message.includes(text), text);
        }
        return true;
    });
});
