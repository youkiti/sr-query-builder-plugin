// 可視マウスカーソルの注入（tiab-review-plugin/video には無い、本リポジトリでの新規機能）
//
// Playwright の page.mouse.move() / click() は CDP（Chrome DevTools Protocol）経由で
// マウスイベントを合成するだけで、OS/ブラウザの実カーソル画像は動かない環境が多い
// （ヘッドフルの xvfb 収録でも同様）。操作解説動画としては「今どこを指しているか」が
// 画面に映らないと致命的なため、擬似カーソルの DOM 要素を全ページへ注入し、
// mousemove / mousedown / mouseup イベントに追従させることで解決する。
//
// 実装方針:
//   - browserContext.addInitScript() で「新しい document が作られるたび」に実行される
//     初期化スクリプトとして登録する。Playwright は内部で CDP の
//     Page.addScriptToEvaluateOnNewDocument を使っており、これは実行コンテキストへ
//     直接コードを注入する仕組みのため、拡張ページの CSP（manifest の
//     content_security_policy.extension_pages = "script-src 'self' ..."）の対象にならない
//     （CSP が制限するのは <script src="..."> やインライン <script> タグ、eval 等、
//     HTML パーサ / JS エンジン経由で読み込まれるスクリプトであり、CDP 越しに
//     Runtime へ注入されるコードはそもそも CSP の検査対象ではない）。
//   - コンテキストレベルで登録するため、record.mjs が `ctx.newSegment()` で新しいタブへ
//     切り替えても（＝新しい page が作られても）自動的に再注入される。個別ページや
//     goto のたびに手動で再注入する必要はない。
//   - 万一どうしても映らない場合の代替案（フォールバック）: 各シーンスクリプト側で
//     `page.evaluate(installCursorScript)` を goto 直後に都度呼び出す方式に切り替える
//     （その場合はナビゲーション直後のごく短い間だけカーソルが消える瞬間が生じうる）。
//
// 見た目: 白地に青の輪郭を持つ矢印カーソル（本拡張の公開ページのトンマナに合わせた
// 配色。hosted/style.css の --primary: #2a63d6 / --primary-light: #5b93ef）+
// クリック時のリップル（波紋）アニメーション。
// z-index は最大値、pointer-events: none で実際のクリック判定を阻害しない。

/**
 * ブラウザコンテキストへ可視カーソルの初期化スクリプトを登録する。
 * launchPersistentContext 直後、最初のページ遷移が起きるより前に呼び出すこと。
 * @param {import('playwright').BrowserContext} context
 */
export async function installCursor(context) {
    await context.addInitScript(installCursorScript);
}

/**
 * ページの実行コンテキストへ直接注入される初期化関数の本体。
 * addInitScript に関数として渡すと Playwright がそのまま文字列化して注入するため、
 * この関数の外側のスコープ（import 等）は一切参照できない点に注意する
 * （必要な定数はすべてこの関数の中に閉じ込めている）。
 */
function installCursorScript() {
    // 同じ document へ複数回注入されるのを防ぐ（保険。通常は addInitScript 側で1回のみ）
    if (window.__srVideoCursorInstalled) return;
    window.__srVideoCursorInstalled = true;

    const CURSOR_COLOR = '#2a63d6';
    const RIPPLE_COLOR = '#5b93ef';
    const Z_INDEX = '2147483647'; // 32bit 符号付き整数の最大値。他のどの要素よりも手前に出す

    const setup = () => {
        // document.documentElement は <html> 開始タグのパース直後から存在するため、
        // addInitScript のタイミング（DOM 構築前）でも通常はここに到達できるが、
        // 念のため無ければ次フレームへ再試行する。
        if (!document.documentElement) {
            requestAnimationFrame(setup);
            return;
        }

        const cursor = document.createElement('div');
        cursor.id = '__sr-video-cursor__';
        cursor.setAttribute('aria-hidden', 'true');
        Object.assign(cursor.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            pointerEvents: 'none',
            zIndex: Z_INDEX,
            transform: 'translate(-100px, -100px)',
            transition: 'transform 0.06s linear',
            willChange: 'transform',
        });
        // 矢印カーソル（SVG）。白地+青の輪郭で、明暗どちらの背景でも視認できるようにする。
        cursor.innerHTML =
            '<svg width="30" height="30" viewBox="0 0 30 30" ' +
            'style="display:block;overflow:visible;filter:drop-shadow(0 1px 3px rgba(0,0,0,.45))">' +
            '<path d="M3 2 L3 23 L9.5 17.5 L13 26 L17 24.3 L13.6 16 L21 16 Z" ' +
            'fill="#ffffff" stroke="' + CURSOR_COLOR + '" stroke-width="1.6" stroke-linejoin="round" />' +
            '</svg>';

        // クリック時に広がるリップル（波紋）
        const ripple = document.createElement('div');
        ripple.id = '__sr-video-cursor-ripple__';
        ripple.setAttribute('aria-hidden', 'true');
        Object.assign(ripple.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '36px',
            height: '36px',
            marginLeft: '-18px',
            marginTop: '-18px',
            borderRadius: '50%',
            border: '3px solid ' + RIPPLE_COLOR,
            boxSizing: 'border-box',
            pointerEvents: 'none',
            zIndex: Z_INDEX,
            opacity: '0',
            transform: 'translate(-100px, -100px) scale(0.4)',
        });

        // 擬似カーソルは document.body ではなく document.documentElement（<html>）へ
        // マウントする。zoom.mjs の applyPageZoom() は document.body.style.zoom を
        // 設定するため、body の子孫はレイアウト上すべて zoom 倍率がかかる。
        // カーソルは position: fixed + transform: translate(clientX px, clientY px) で
        // 位置決めしており、body 配下に置くとこの translate 量まで zoom 倍されてしまい、
        // 実際のポインタ座標（clientX/clientY はビューポート基準で zoom の影響を受けない）
        // からずれた位置に描画される（例: clientX=950, zoom=1.8 → 描画位置が約1710pxに
        // ずれる）。<html> 直下なら zoom がかかった祖先の外側になるため、fixed 要素は
        // ビューポート座標のまま正しく描画される。
        // documentElement は HTML パース開始直後から存在するため、setup() 冒頭の
        // requestAnimationFrame 待ちが解決した時点で確実に利用でき、body の存在を
        // 待つ必要はない。
        document.documentElement.appendChild(cursor);
        document.documentElement.appendChild(ripple);

        const moveTo = (x, y) => {
            cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
        };

        window.addEventListener(
            'mousemove',
            (event) => {
                moveTo(event.clientX, event.clientY);
            },
            { capture: true, passive: true },
        );

        window.addEventListener(
            'mousedown',
            (event) => {
                // カーソル自体を少し縮めてクリック感を出す
                cursor.style.transform =
                    'translate(' + event.clientX + 'px, ' + event.clientY + 'px) scale(0.85)';
                // リップルを即座にクリック位置へ出し、その後拡大しながらフェードアウトさせる
                ripple.style.transition = 'none';
                ripple.style.opacity = '0.9';
                ripple.style.transform =
                    'translate(' + event.clientX + 'px, ' + event.clientY + 'px) scale(0.4)';
                // 直前の transition: none を確実に反映させてから次の transition を effective にする
                // （reflow を強制するための読み取り）
                void ripple.offsetWidth;
                ripple.style.transition = 'transform 0.45s ease-out, opacity 0.45s ease-out';
                ripple.style.transform =
                    'translate(' + event.clientX + 'px, ' + event.clientY + 'px) scale(1.8)';
                ripple.style.opacity = '0';
            },
            { capture: true, passive: true },
        );

        window.addEventListener(
            'mouseup',
            (event) => {
                cursor.style.transform = 'translate(' + event.clientX + 'px, ' + event.clientY + 'px) scale(1)';
            },
            { capture: true, passive: true },
        );
    };

    setup();
}
