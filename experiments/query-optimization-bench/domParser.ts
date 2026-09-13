import { JSDOM } from 'jsdom';

/**
 * `efetchArticles`（src/lib/ncbi/eutils.ts）はブラウザ標準の DOMParser に依存しており、
 * Node で動くこのハーネスにはグローバルに存在しない。jsdom の DOMParser を補うことで、
 * seeded 版 C0 生成が拡張本体と同じ efetchArticles をそのまま使えるようにする。
 *
 * 既に DOMParser が存在する環境（jest の jsdom 環境等）では何もしない。
 */
export function installDomParser(): void {
  const target = globalThis as { DOMParser?: unknown };
  if (typeof target.DOMParser === 'undefined') {
    target.DOMParser = new JSDOM('').window.DOMParser;
  }
}
