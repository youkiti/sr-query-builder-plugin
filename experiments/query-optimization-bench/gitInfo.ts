import { execFileSync } from 'node:child_process';

/**
 * 実行時の git HEAD / 作業ツリーの汚れを記録するためのローカル専用ヘルパ。
 * git が無い・リポジトリ外など、取得に失敗しても実行そのものは止めない（null を返す）。
 */
export function getGitCommit(cwd = process.cwd()): string | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim();
    return commit || null;
  } catch {
    return null;
  }
}

export function isGitDirty(cwd = process.cwd()): boolean | null {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8');
    return status.trim().length > 0;
  } catch {
    return null;
  }
}
