/** @jest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGitCommit, isGitDirty } from './gitInfo';

test('リポジトリ内では git HEAD と汚れの有無を返す', () => {
  const commit = getGitCommit();
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof isGitDirty()).toBe('boolean');
});

test('git が使えない場所（リポジトリ外の一時ディレクトリ）では例外を投げず null を返す', () => {
  const outside = mkdtempSync(join(tmpdir(), 'gitinfo-'));
  expect(getGitCommit(outside)).toBeNull();
  expect(isGitDirty(outside)).toBeNull();
});
