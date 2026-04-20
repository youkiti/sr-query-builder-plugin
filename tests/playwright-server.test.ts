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
    expect(safeJoin(rootDir, '/..\\dist-evil\\file.txt')).toBeNull();
  });
});
