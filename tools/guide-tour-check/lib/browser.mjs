import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../../../video/scripts/config.mjs';
import { Run } from './run.mjs';

export function stopProfileProcesses(profile, warn, { platform = process.platform, execute = execFileSync } = {}) {
    const commandOptions = { encoding: 'utf8', timeout: 5000, windowsHide: true };
    try {
        if (platform === 'win32') {
            const output = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"], commandOptions);
            const processes = JSON.parse(output || '[]');
            for (const entry of (Array.isArray(processes) ? processes : [processes])) {
                if (!entry?.CommandLine?.includes(profile) || !Number.isSafeInteger(entry.ProcessId) || entry.ProcessId <= 0) continue;
                try {
                    execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                        `$ErrorActionPreference = 'Stop'; Stop-Process -Id ${entry.ProcessId} -Force`], commandOptions);
                } catch {
                    warn(`ブラウザのプロセス ${entry.ProcessId} を停止できませんでした`);
                }
            }
        } else {
            // pkill の正規表現で、パスの記号も文字どおりに照合する。
            const pattern = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            execute('pkill', ['-f', pattern], commandOptions);
        }
    } catch (error) {
        if (platform !== 'win32' && (error.code === 'ENOENT' || error.status === 1)) return;
        warn('ブラウザのプロセスの一覧取得・停止に失敗しました');
    }
}

export async function withFreshBrowser(scenario, options, extensionDir, warnings, {
    launch = (profile, settings) => chromium.launchPersistentContext(profile, settings),
    closeTimeoutMs = 15000,
    stopProcesses = stopProfileProcesses,
    removeProfile = rmSync,
    warn = console.warn,
} = {}) {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'sr-tour-check-'));
    const report = message => warn(`警告: ${scenario.name}: ${message}`);
    let context;
    try {
        context = await launch(profile, {
            headless: false,
            executablePath: resolveChromiumExecutable(),
            viewport: options.size,
            locale: options.lang,
            args: [
                `--disable-extensions-except=${extensionDir}`,
                `--load-extension=${extensionDir}`,
                `--window-size=${options.size.width},${options.size.height}`,
                `--lang=${options.lang}`,
            ],
        });
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        const run = new Run(scenario.name, page, new URL(worker.url()).host, options.lang, extensionDir, warnings);
        await scenario.run(run);
    } finally {
        try {
            if (context) {
                let timer;
                try {
                    const closed = await Promise.race([
                        Promise.resolve().then(() => context.close()).then(() => true),
                        new Promise(resolve => { timer = setTimeout(() => resolve(false), closeTimeoutMs); }),
                    ]);
                    if (!closed) {
                        report(`ブラウザの終了が ${closeTimeoutMs / 1000} 秒以内に戻らなかったので、待たずに続けます`);
                        try {
                            stopProcesses(profile, report);
                        } catch {
                            report('ブラウザのプロセスを停止できませんでした');
                        }
                    }
                } catch {
                    report('ブラウザの終了に失敗しました');
                } finally {
                    clearTimeout(timer);
                }
            }
        } finally {
            // mkdtemp が作った、この実行専用の OS 一時ディレクトリだけを削除する。
            const resolved = path.resolve(profile);
            if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sr-tour-check-')) {
                throw new Error(`一時プロファイルの削除対象が不正です: ${resolved}`);
            }
            try {
                removeProfile(resolved, { recursive: true, force: true });
            } catch {
                report(`一時プロファイルを削除できませんでした: ${resolved}`);
            }
        }
    }
}
