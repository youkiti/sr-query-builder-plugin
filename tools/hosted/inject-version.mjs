import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function injectVersion(siteDir, manifestPath) {
  const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('manifest の version が不正です');
  for (const name of await readdir(siteDir)) {
    if (!name.endsWith('.html')) continue;
    const path = resolve(siteDir, name);
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replaceAll('__APP_VERSION__', version));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await injectVersion(resolve(process.argv[2] ?? '_site'), resolve('src/manifest.json'));
}
