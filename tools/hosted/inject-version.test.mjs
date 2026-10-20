import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectVersion } from './inject-version.mjs';

test('配信側だけに manifest の版を差し込む', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-version-'));
  try {
    const site = join(dir, '_site');
    await mkdir(site);
    const source = '<span data-app-version>__APP_VERSION__</span>';
    await writeFile(join(dir, 'source.html'), source);
    await writeFile(join(site, 'index.html'), source + source);
    await writeFile(join(site, 'lang.js'), '__APP_VERSION__');
    await writeFile(join(dir, 'manifest.json'), '{"version":"1.2.3"}');
    await injectVersion(site, join(dir, 'manifest.json'));
    assert.equal(await readFile(join(site, 'index.html'), 'utf8'), source.replaceAll('__APP_VERSION__', '1.2.3').repeat(2));
    assert.equal(await readFile(join(dir, 'source.html'), 'utf8'), source);
    assert.equal(await readFile(join(site, 'lang.js'), 'utf8'), '__APP_VERSION__');
    await writeFile(join(dir, 'manifest.json'), '{"version":"<invalid>"}');
    await assert.rejects(injectVersion(site, join(dir, 'manifest.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('公開文書の対象版を手書きしない', async () => {
  const paths = [
    'README.md',
    ...(await readdir('hosted')).filter((name) => name.endsWith('.html')).map((name) => `hosted/${name}`),
    ...(await readdir('docs/store')).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => `docs/store/${name}`),
  ];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /(?:対象バージョン|Covers|ステータス)[^\n]*v0\.\d+\.\d+/, path);
    assert.doesNotMatch(text, /v0\.3\.0/, path);
  }
  for (const name of ['index', 'help', 'privacy-policy', 'terms-of-service']) {
    const text = await readFile(`hosted/${name}.html`, 'utf8');
    assert.match(text, /data-app-version>__APP_VERSION__/);
    assert.match(text, /version: 2026-10-20/);
    assert.match(text, /最終更新: 2026-10-20/);
    assert.doesNotMatch(text, /—/);
  }
  const workflow = await readFile('.github/workflows/deploy-pages.yml', 'utf8');
  assert.match(workflow, /'src\/manifest.json'/);
  assert.match(workflow, /node tools\/hosted\/inject-version.mjs _site/);
});
