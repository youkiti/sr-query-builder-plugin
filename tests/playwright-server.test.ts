import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safeJoin } = require('../tools/playwright-server.js');

describe('safeJoin', () => {
  const rootDir = path.resolve('dist');

  test('allows files under the dist root', () => {
    expect(safeJoin(rootDir, '/popup/popup.html')).toBe(path.join(rootDir, 'popup', 'popup.html'));
  });

  test('allows resolving the dist root itself', () => {
    expect(safeJoin(rootDir, '/')).toBe(rootDir);
  });

  test('rejects traversal into sibling paths that only share the same prefix', () => {
    expect(safeJoin(rootDir, '/../dist-evil/file.txt')).toBeNull();
  });

  // POSIX の path はバックスラッシュをパス区切りとして扱わないため、Windows 形式の
  // traversal パス（`\` 区切り）は `..` セグメントに分解されず、1 個のファイル名として
  // rootDir 配下に解決されてしまう（safeJoin 自体の不具合ではない）。この assertion は
  // Windows 上でのみ意味を持つため、Windows 限定で検証する。
  (process.platform === 'win32' ? test : test.skip)(
    'rejects traversal into sibling paths using Windows-style backslash separators (win32 only)',
    () => {
      expect(safeJoin(rootDir, '/..\\dist-evil\\file.txt')).toBeNull();
    },
  );
});
