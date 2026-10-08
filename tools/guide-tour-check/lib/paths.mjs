import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const OUT_DIR = path.join(REPO_ROOT, '.tmp', 'guide-tour-check');

export function resolveDemoDir(env = process.env) {
    // 動画と同じ EXT_DIST_DIR を使えるが、通常ビルドへのフォールバックはしない。
    const dir = path.resolve(REPO_ROOT, env.EXT_DIST_DIR || 'dist-demo');
    for (const file of ['manifest.json', 'app/app.html', 'app/app.js', 'options/options.html']) {
        if (!existsSync(path.join(dir, file))) {
            throw new Error(`デモビルドの ${file} がありません: ${dir}。先に npm run build:demo を実行してください`);
        }
    }
    if (!readFileSync(path.join(dir, 'app/app.js'), 'utf8').includes('./src/demo/app-entry.ts')) {
        throw new Error(`デモの入口を確認できません: ${dir}。npm run build:demo で生成したビルドを指定してください`);
    }
    return dir;
}
