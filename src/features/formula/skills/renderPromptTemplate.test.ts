import { renderPromptTemplate } from './renderPromptTemplate';

describe('renderPromptTemplate', () => {
  test('単純なプレースホルダを置換する', () => {
    expect(renderPromptTemplate('hello {{NAME}}', { NAME: 'world' })).toBe('hello world');
  });

  test('複数のプレースホルダをそれぞれ置換する', () => {
    const result = renderPromptTemplate('{{A}} and {{B}}', { A: 'x', B: 'y' });
    expect(result).toBe('x and y');
  });

  test('置換値に $& を含んでも展開されずそのまま挿入される', () => {
    // String.prototype.replace(pattern, replacement) は replacement 側の $& を
    // マッチ文字列（ここでは "{{VALUE}}"）自身に展開してしまう。split/join ベースの
    // 実装ならこの特殊解釈が起きないことを確認する。
    const result = renderPromptTemplate('current: {{VALUE}}', { VALUE: 'drug$& more' });
    expect(result).toBe('current: drug$& more');
  });

  test("置換値に $' を含んでもテンプレートの残り部分が複製されない", () => {
    // $' は「マッチ位置より後ろの文字列全体」に展開される。兄弟ブロックの式に
    // Embase の切り捨て記法 drug$ の直後にクォートが続くようなテキストが来ても、
    // テンプレートの残りが二重に挿入されてはならない。
    const template = "{{SIBLINGS}}\n\n次のセクション: end";
    const result = renderPromptTemplate(template, { SIBLINGS: "drug$' costs" });
    expect(result).toBe("drug$' costs\n\n次のセクション: end");
  });

  test('置換値に $$ を含んでも単一の $ に縮退しない', () => {
    const result = renderPromptTemplate('{{X}}', { X: 'price$$item' });
    expect(result).toBe('price$$item');
  });

  test('同じプレースホルダが複数回出現しても全て置換される', () => {
    const result = renderPromptTemplate('{{X}} - {{X}}', { X: 'v' });
    expect(result).toBe('v - v');
  });

  test('該当するプレースホルダが無ければ何もしない', () => {
    expect(renderPromptTemplate('plain text', { X: 'v' })).toBe('plain text');
  });
});
