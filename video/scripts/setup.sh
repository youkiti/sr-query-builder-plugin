#!/usr/bin/env bash
# 動画制作パイプラインの環境セットアップ（Linux 向け・冪等）
#
# 使い方:
#   bash video/scripts/setup.sh
#   （package.json からは `npm run video:setup` でも実行できる）
#
# 何度実行しても安全なように、各ステップは「既に揃っているか」を確認してからのみ
# ダウンロード・インストールを行う。実行内容:
#   1. npm ci                                  （依存パッケージのインストール）
#   2. Playwright Chromium の取得              （PLAYWRIGHT_CHROMIUM_PATH が既存ならスキップ）
#   3. 日本語フォント（Noto Sans JP）の導入 + fontconfig alias の設定
#                                               （fc-match -s "sans-serif:lang=ja" が既に
#                                                Noto Sans JP を返すならスキップ）
#   4. ffmpeg/ffprobe の取得（BtbN ビルド）     （FFMPEG_PATH 指定 or PATH 上に既存ならスキップ）
#   5. VOICEVOX エンジンの取得・起動           （VOICEVOX_URL が既に応答するならスキップ）
#
# デモビルド層（dist-demo/）はまだ無いため（video/REQUIREMENTS.md の PR2 で追加予定）、
# デモ用フィクスチャ生成ステップは持たない。ffmpeg・VOICEVOX はいずれも video/tools/ 配下に
# 展開する（.gitignore 済み・git 管理外）。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VIDEO_TOOLS_DIR="$REPO_ROOT/video/tools"
mkdir -p "$VIDEO_TOOLS_DIR"

# ----------------------------------------------------------------------------
# 1. npm 依存パッケージ
# ----------------------------------------------------------------------------
echo "==> [1/5] npm ci"
(cd "$REPO_ROOT" && npm ci)

# ----------------------------------------------------------------------------
# 2. Playwright Chromium
# ----------------------------------------------------------------------------
echo "==> [2/5] Playwright Chromium"
if [ -n "${PLAYWRIGHT_CHROMIUM_PATH:-}" ] && [ -e "${PLAYWRIGHT_CHROMIUM_PATH}" ]; then
    echo "    PLAYWRIGHT_CHROMIUM_PATH が既に存在するためスキップ: ${PLAYWRIGHT_CHROMIUM_PATH}"
elif [ -e "/opt/pw-browsers/chromium" ]; then
    echo "    /opt/pw-browsers/chromium が既に存在するためスキップ"
else
    (cd "$REPO_ROOT" && npx playwright install chromium)
fi

# ----------------------------------------------------------------------------
# 3. 日本語フォント（Noto Sans JP）+ fontconfig alias
#    なぜ必要か: 収録用コンテナには日本語フォントが一つも入っておらず、
#    `fc-match -s "sans-serif:lang=ja"` は WenQuanYi Zen Hei（中国語フォント）等に
#    フォールバックしてしまう。アプリの CSS（src/styles/tokens.css の --font-family-sans）は
#    `-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo",
#    sans-serif` を指定しているが、Hiragino Sans は macOS 専用・Yu Gothic UI / Meiryo は
#    Windows 専用のため、Linux の収録環境ではどれも解決できず末尾の総称 `sans-serif` まで
#    落ちる。このとき fontconfig が `sans-serif:lang=ja` をどのフォントへ解決するかは
#    システムに入っている日本語対応フォント次第で、Noto Sans JP が入っていなければ
#    中国語フォントへフォールバックし、動画中の日本語が不自然になる（アプリ側の指定自体は
#    正しく、実機の macOS / Windows 利用者には起きない。収録環境固有の問題）。
#
#    重要（実測で判明。以前の版の誤り）: Noto Sans JP を "導入するだけ"（フォントファイルを
#    置くだけ）では解決先は変わらない。本コンテナには元から IPAPGothic 等の日本語フォントも
#    入っており、`fc-match "Noto Sans JP"` は単体では解決できても、総称 `sans-serif:lang=ja`
#    の解決は /etc/fonts/conf.d/ 配下の他ルール（例: 64-wqy-zenhei.conf が sans-serif を
#    WenQuanYi Zen Hei に prepend する alias）が既に存在し、これらは `<edit binding="weak">`
#    （既定値）で「まだ sans-serif が残っている位置の直前」に挿入される方式のため、
#    後から素朴に `<alias><family>sans-serif</family><prefer>...</prefer></alias>` や
#    同等の weak な `<match><edit mode="prepend">` を追加しても、conf.d 内のファイル名の
#    処理順（辞書順）次第で位置が決まってしまい、確実に先頭へは来ない（このセッションで
#    実際に検証済み: 素朴な alias / weak prepend はどちらも WenQuanYi Zen Hei に負けた）。
#    確実に勝たせるには `<edit name="family" mode="prepend" binding="strong">` を使う
#    （strong 束縛はリスト内の位置に関係なく優先される。実測で確認済み）。
#
#    さらに重要（これも実測で判明）: 上記の strong prepend ルールに `<test name="lang"
#    compare="contains"><string>ja</string></test>` を付けて "lang=ja のときだけ" 発動する
#    条件付きにすると、`fc-match -s "sans-serif:lang=ja"`（CLI から明示的に lang=ja を
#    指定するテスト呼び出し）では正しく Noto Sans JP に解決されるにもかかわらず、実際に
#    Chromium で日本語テキストを描画すると WenQuanYi Zen Hei のままだった（CDP の
#    CSS.getPlatformFontsForNode で確認）。原因は fontconfig の `FcDefaultSubstitute` が
#    パターンに lang を補うとき、レンダリング対象テキストの文字種ではなく本コンテナの
#    ロケール環境変数（LANG/LC_ALL。本コンテナでは未設定＝POSIX）を見るため、Chromium
#    からの実際のフォント問い合わせには lang=ja が乗らないこと。Playwright の
#    `locale: 'ja'`（record.mjs が設定）は Blink 側の言語設定であり、fontconfig が読む
#    OS ロケール環境変数とは別物なので、これも回避策にならない。そのため本ルールは
#    lang 条件を付けず、family=sans-serif に対して常に Noto Sans JP を strong prepend
#    する（本コンテナは動画収録専用でロケール依存の多言語対応は不要なため、無条件
#    上書きで問題ない）。
#    注意点:
#      - github.com のリリース配布はこのセッションのネットワークポリシーで弾かれるため、
#        raw.githubusercontent.com 経由で取得する
#      - 取得できるのは可変フォント（wght 軸）で、fontconfig 上の既定インスタンス名は
#        "Noto Sans JP Thin" になるが、Chromium はウェイト軸を正しく適用するため
#        実際の描画は通常の太さになる
#      - コンテナは揮発するため、セッションごとに再導入が必要になる
#      - ダウンロード失敗・alias 未反映は動画の日本語品質に直結するため、警告に留めず
#        致命的エラーにする（中国語フォントのまま気付かずに収録し直す方が手戻りが大きいため）
# ----------------------------------------------------------------------------
echo "==> [3/5] 日本語フォント（Noto Sans JP）+ fontconfig alias"

# 旧名の掃除（冪等性のため）: このルールは lang 条件を付けていない（付けると Chromium の
# 実描画に効かないため。3-2 のコメント参照）にもかかわらず、以前は `90-notosansjp-lang-ja.conf`
# という lang 条件付きに見える名前で書き出していた。実態に合わせて
# `90-notosansjp-sans-serif.conf`（下記 ALIAS_FILENAME）に改名したため、過去のセッションで
# 旧名のファイルが残っていても新名の書き出しと衝突しないよう、見つかり次第削除する
# （新名のファイルは以下の通常フローで改めて書き出されるため、無条件に消してよい）。
OLD_ALIAS_FILENAME="90-notosansjp-lang-ja.conf"
for old_dir in "/etc/fonts/conf.d" "$HOME/.config/fontconfig/conf.d"; do
    old_alias_path="$old_dir/$OLD_ALIAS_FILENAME"
    if [ -f "$old_alias_path" ]; then
        echo "    旧名の fontconfig alias を削除します: $old_alias_path"
        rm -f "$old_alias_path"
        fc-cache -f >/dev/null
    fi
done

check_notojp_ja_resolution() {
    fc-match -s "sans-serif:lang=ja" 2>/dev/null | head -1
}

if check_notojp_ja_resolution | grep -q "Noto Sans JP"; then
    echo "    総称 sans-serif の lang=ja 解決先は既に Noto Sans JP のためスキップ: $(check_notojp_ja_resolution)"
else
    # 3-1. フォント本体（無ければ導入。既に入っていれば alias 設定だけ行う）
    NOTOJP_MATCH="$(fc-match "Noto Sans JP" 2>/dev/null || true)"
    if echo "$NOTOJP_MATCH" | grep -q "Noto Sans JP"; then
        echo "    Noto Sans JP のフォント本体は導入済み（alias 未反映のため設定します）: $NOTOJP_MATCH"
    else
        NOTOJP_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
        NOTOJP_SYSTEM_DIR="/usr/share/fonts/truetype/notojp"
        NOTOJP_USER_DIR="$HOME/.fonts"
        if mkdir -p "$NOTOJP_SYSTEM_DIR" 2>/dev/null; then
            NOTOJP_DIR="$NOTOJP_SYSTEM_DIR"
        else
            echo "    $NOTOJP_SYSTEM_DIR に書き込み権限が無いため $NOTOJP_USER_DIR にフォールバックします"
            NOTOJP_DIR="$NOTOJP_USER_DIR"
            mkdir -p "$NOTOJP_DIR"
        fi
        echo "    Noto Sans JP をダウンロードします... (-> $NOTOJP_DIR)"
        if curl -sSL -f -o "$NOTOJP_DIR/NotoSansJP.ttf" "$NOTOJP_URL"; then
            fc-cache -f "$NOTOJP_DIR" >/dev/null
            echo "    Noto Sans JP を導入しました: $NOTOJP_DIR/NotoSansJP.ttf"
        else
            rm -f "$NOTOJP_DIR/NotoSansJP.ttf"
            echo "    エラー: Noto Sans JP のダウンロードに失敗しました（$NOTOJP_URL）。" >&2
            echo "    このまま収録すると、動画中の日本語が中国語フォントで描画されてしまいます。" >&2
            echo "    ネットワーク到達性を確認するか、手動でフォントを $NOTOJP_DIR に配置してから" >&2
            echo "    再実行してください。" >&2
            exit 1
        fi
    fi

    # 3-2. fontconfig alias（総称 sans-serif の lang=ja 解決先を強制的に Noto Sans JP にする）
    #      書き込み権限のフォールバック方針はフォント本体（3-1）と同じ考え方:
    #      システムの /etc/fonts/conf.d/ に書ければそちらを使い、書けなければ
    #      $HOME/.config/fontconfig/conf.d/ に置く。
    #      ファイル名に lang-ja を含めない理由: このルール自体は lang 条件を付けていない
    #      （付けると Chromium の実描画に効かないため。下記 <match> 直下のコメント参照）。
    #      lang 条件付きだと誤解させる名前を避けるため、実態どおり sans-serif とした。
    ALIAS_FILENAME="90-notosansjp-sans-serif.conf"
    ALIAS_SYSTEM_DIR="/etc/fonts/conf.d"
    ALIAS_USER_DIR="$HOME/.config/fontconfig/conf.d"
    if [ -w "$ALIAS_SYSTEM_DIR" ] || mkdir -p "$ALIAS_SYSTEM_DIR" 2>/dev/null; then
        ALIAS_DIR="$ALIAS_SYSTEM_DIR"
    else
        echo "    $ALIAS_SYSTEM_DIR に書き込み権限が無いため $ALIAS_USER_DIR にフォールバックします"
        ALIAS_DIR="$ALIAS_USER_DIR"
        mkdir -p "$ALIAS_DIR"
    fi
    ALIAS_PATH="$ALIAS_DIR/$ALIAS_FILENAME"
    echo "    fontconfig alias を書き出します: $ALIAS_PATH"
    cat > "$ALIAS_PATH" <<'FONTCONF_EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- video/scripts/setup.sh が生成（動画収録セッション専用）。
       総称 sans-serif の解決先を Noto Sans JP に強制する。
       binding="strong" が必須: 既定の binding="weak" では、コンテナに元から入っている
       他の conf.d ルール（中国語 WenQuanYi Zen Hei 等の sans-serif alias）が
       ファイル名の処理順次第で割り込み、Noto Sans JP より先に解決されてしまう
       （このファイルの導入前に実測で確認済み）。
       lang=ja 条件を付けない理由: Chromium の実際のフォント問い合わせは、描画する
       テキストの文字種ではなく本コンテナのロケール環境変数（LANG/LC_ALL）由来の lang で
       fontconfig に渡るため、本コンテナのように LANG が未設定だと lang=ja 条件付きの
       ルールは発動せず、CDP で確認しても WenQuanYi Zen Hei のままだった（実測で確認済み。
       Playwright の locale:'ja' も Blink 側の設定でありここには効かない）。本コンテナは
       動画収録専用のため、family=sans-serif への無条件上書きで問題ない。 -->
  <match target="pattern">
    <test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Noto Sans JP</string></edit>
  </match>
</fontconfig>
FONTCONF_EOF
    fc-cache -f >/dev/null

    # 3-3. 検証: fc-match が通るだけでは不十分（Noto Sans JP 単体の解決は alias 抜きでも
    #      通ってしまうため）。実際に総称 sans-serif:lang=ja の解決先が変わったかを確認する。
    NOTOJP_JA_RESULT="$(check_notojp_ja_resolution)"
    if echo "$NOTOJP_JA_RESULT" | grep -q "Noto Sans JP"; then
        echo "    OK: sans-serif:lang=ja -> $NOTOJP_JA_RESULT"
    else
        echo "    エラー: fontconfig alias を書き出しましたが、sans-serif:lang=ja の解決先が" >&2
        echo "    Noto Sans JP になりませんでした（実際の解決結果: $NOTOJP_JA_RESULT）。" >&2
        echo "    このまま収録すると、動画中の日本語が中国語フォント等で描画されてしまいます。" >&2
        echo "    $ALIAS_PATH の内容と書き込み先（fontconfig がそのディレクトリを読む設定に" >&2
        echo "    なっているか）を確認してください。" >&2
        exit 1
    fi
fi

# ----------------------------------------------------------------------------
# 4. ffmpeg / ffprobe（BtbN FFmpeg-Builds の静的バイナリ、linux64-gpl・rolling latest）
#    注意: BtbN の "latest" タグはローリング更新のため、バイナリの厳密なバージョン固定は
#    されない（再現性が必要な場合は FFMPEG_PATH / FFPROBE_PATH で固定バイナリを明示する）。
# ----------------------------------------------------------------------------
echo "==> [4/5] ffmpeg / ffprobe"
FFMPEG_DIR="$VIDEO_TOOLS_DIR/ffmpeg-master-latest-linux64-gpl"
if [ -n "${FFMPEG_PATH:-}" ] && [ -e "${FFMPEG_PATH}" ]; then
    echo "    FFMPEG_PATH が既に存在するためスキップ: ${FFMPEG_PATH}"
elif command -v ffmpeg >/dev/null 2>&1; then
    echo "    PATH 上に ffmpeg が見つかったためスキップ: $(command -v ffmpeg)"
elif [ -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
    echo "    video/tools/ に展開済みのためダウンロードをスキップ: $FFMPEG_DIR/bin/ffmpeg"
else
    echo "    BtbN/FFmpeg-Builds (linux64-gpl, latest) をダウンロードします..."
    curl -sSL -o "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz" \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
    tar -xf "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz" -C "$VIDEO_TOOLS_DIR"
    rm -f "$VIDEO_TOOLS_DIR/ffmpeg.tar.xz"
fi
if [ -x "$FFMPEG_DIR/bin/ffmpeg" ] && [ -z "${FFMPEG_PATH:-}" ] && ! command -v ffmpeg >/dev/null 2>&1; then
    echo "    ffmpeg/ffprobe を展開しました。実行時は以下を指定してください:"
    echo "      export FFMPEG_PATH=$FFMPEG_DIR/bin/ffmpeg"
    echo "      export FFPROBE_PATH=$FFMPEG_DIR/bin/ffprobe"
fi

# ----------------------------------------------------------------------------
# 5. VOICEVOX エンジン（linux-cpu-x64, バージョン固定）
# ----------------------------------------------------------------------------
echo "==> [5/5] VOICEVOX エンジン"
VOICEVOX_VERSION="0.24.1"
VOICEVOX_URL_CHECK="${VOICEVOX_URL:-http://127.0.0.1:50021}"
VOICEVOX_DIR="$VIDEO_TOOLS_DIR/voicevox"
VOICEVOX_ENGINE_BIN="$VOICEVOX_DIR/linux-cpu-x64/run"

if curl -sS -o /dev/null -m 3 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
    echo "    VOICEVOX エンジンは既に起動中です: $VOICEVOX_URL_CHECK"
else
    if [ -x "$VOICEVOX_ENGINE_BIN" ]; then
        echo "    video/tools/ に展開済みのためダウンロードをスキップ: $VOICEVOX_ENGINE_BIN"
    else
        echo "    VOICEVOX エンジン v${VOICEVOX_VERSION}（linux-cpu-x64）をダウンロードします..."
        echo "    ※ 7z 展開に python3 の py7zr を使用します（未インストールの場合: pip install py7zr）"
        mkdir -p "$VOICEVOX_DIR"
        curl -sSL -o "$VIDEO_TOOLS_DIR/voicevox_engine.7z" \
            "https://github.com/VOICEVOX/voicevox_engine/releases/download/${VOICEVOX_VERSION}/voicevox_engine-linux-cpu-x64-${VOICEVOX_VERSION}.7z.001"
        python3 -c "
import py7zr
with py7zr.SevenZipFile('$VIDEO_TOOLS_DIR/voicevox_engine.7z', mode='r') as z:
    z.extractall(path='$VOICEVOX_DIR')
"
        rm -f "$VIDEO_TOOLS_DIR/voicevox_engine.7z"
        chmod +x "$VOICEVOX_ENGINE_BIN"
    fi

    echo "    VOICEVOX エンジンをバックグラウンドで起動します..."
    nohup "$VOICEVOX_ENGINE_BIN" --host 127.0.0.1 --port 50021 \
        > "$VIDEO_TOOLS_DIR/voicevox.log" 2>&1 &
    disown

    echo "    起動待機中..."
    for _ in $(seq 1 60); do
        if curl -sS -o /dev/null -m 2 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
            echo "    VOICEVOX エンジンが起動しました: $VOICEVOX_URL_CHECK"
            break
        fi
        sleep 2
    done
    if ! curl -sS -o /dev/null -m 3 "$VOICEVOX_URL_CHECK/version" 2>/dev/null; then
        echo "    警告: VOICEVOX エンジンの起動確認ができませんでした。ログを確認してください: $VIDEO_TOOLS_DIR/voicevox.log" >&2
    fi
fi

echo ""
echo "セットアップ完了。"
echo "次のコマンドで動画を生成できます（デモビルド層はまだ無いため、収録対象は"
echo "npm run dev の dist/ になります。resolveExtensionDir() が dist-demo/ を優先するため、"
echo "後続 PR でデモビルドを追加すれば自動的にそちらへ切り替わります）:"
echo "  npm run dev"
echo "  xvfb-run -a -s \"-screen 0 1920x1080x24\" npm run video:record"
echo "  npm run video:tts"
echo "  npm run video:assemble"
