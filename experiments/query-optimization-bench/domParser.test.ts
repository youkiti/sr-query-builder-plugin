/** @jest-environment node */
import { installDomParser } from './domParser';

test('node 環境では DOMParser を jsdom から補い、既存のものは上書きしない', () => {
  const target = globalThis as { DOMParser?: unknown };
  delete target.DOMParser;
  installDomParser();
  expect(typeof target.DOMParser).toBe('function');
  const DOMParserCtor = (globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser;
  const doc = new DOMParserCtor().parseFromString('<a>1</a>', 'text/xml');
  expect(doc.getElementsByTagName('a')[0]?.textContent).toBe('1');

  const sentinel = target.DOMParser;
  installDomParser();
  expect(target.DOMParser).toBe(sentinel);
});
