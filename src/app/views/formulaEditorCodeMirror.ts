/* istanbul ignore file -- CodeMirror 統合は DOM-heavy かつ実ブラウザ依存で、
   jsdom では描画の検証が不可能。architecture.md §4.4 の「100 % カバレッジ到達が
   難しいファイル」に該当するため都度 exclude する運用に沿って coverage 対象外とする。
   本ファイルは src/app/app.ts からのみ import され、bootstrap.ts 側には持ち込まない
   （bootstrap.test.ts 経由で CodeMirror の ESM が jest に読み込まれるのを避けるため）。
   テスト観点では、editView の `enhanceEditor` callback が呼ばれることは stub で確認する。 */

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';

/**
 * editView が生成した `<textarea class="edit__formula">` を CodeMirror 6 に
 * 置き換える。テキストエリアは `display: none` で DOM に残し、「唯一の source of
 * truth」として維持する（他の処理が `textarea.value` / input イベントで動いている
 * ため互換を維持するのが最小変更）。
 *
 * 双方向同期:
 * - CodeMirror 編集 → textarea.value を更新して input イベントを発火
 * - 外部から textarea.value 書換（例: 行単位 AI 改善の accept） → CodeMirror を dispatch で更新
 *   無限ループを防ぐため、方向フラグで同期元を識別する。
 */
export function mountCodeMirrorFormulaEditor(textarea: HTMLTextAreaElement): void {
  const doc = textarea.ownerDocument;
  textarea.style.display = 'none';
  const host = doc.createElement('div');
  host.className = 'edit__formula-cm';
  textarea.parentNode?.insertBefore(host, textarea);

  let syncingFromTextarea = false;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([]),
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingFromTextarea) {
            const next = update.state.doc.toString();
            textarea.value = next;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }),
      ],
    }),
  });

  textarea.addEventListener('input', () => {
    const next = textarea.value;
    const current = view.state.doc.toString();
    if (next === current) {
      return;
    }
    syncingFromTextarea = true;
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: next },
      });
    } finally {
      syncingFromTextarea = false;
    }
  });
}
