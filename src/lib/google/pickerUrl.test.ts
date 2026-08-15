import {
  PICKER_PAGE_URL,
  buildPickerUrl,
  isExtensionRedirectUri,
  parsePickerRedirect,
} from './pickerUrl';

// 本拡張の拡張機能 ID（src/manifest.json の固定 key に由来。isExtensionRedirectUri は
// この ID との完全一致を要求するため、ダミー ID では検証にならない）
const REDIRECT_URI = 'https://bckokafmjighegpjiocopkagghppnjld.chromiumapp.org/picker';

describe('PICKER_PAGE_URL', () => {
  test('DefinePlugin を通らない環境では本番の配信 URL にフォールバックする', () => {
    // `typeof` ガードが効いていないと、ここへ来る前に ReferenceError で落ちる
    expect(PICKER_PAGE_URL).toBe('https://youkiti.github.io/sr-query-builder-plugin/picker.html');
  });
});

describe('buildPickerUrl', () => {
  test('パラメータはクエリではなくフラグメントに載せる', () => {
    const url = buildPickerUrl({
      spreadsheetId: 'sheet-1',
      email: 'me@example.com',
      redirectUri: REDIRECT_URI,
      baseUrl: 'https://example.test/picker.html',
    });
    expect(url.startsWith('https://example.test/picker.html#')).toBe(true);
    // クエリ文字列（?）に混ざると配信サーバーのログにメールアドレスが残る
    expect(url).not.toContain('?');

    const params = new URLSearchParams(url.split('#')[1]);
    expect(params.get('redirect')).toBe(REDIRECT_URI);
    expect(params.get('fileId')).toBe('sheet-1');
    expect(params.get('email')).toBe('me@example.com');
  });

  test('spreadsheetId / email は省略できる（全スプレッドシート表示になる）', () => {
    const url = buildPickerUrl({ redirectUri: REDIRECT_URI, baseUrl: 'https://example.test/p.html' });
    const params = new URLSearchParams(url.split('#')[1]);
    expect(params.get('redirect')).toBe(REDIRECT_URI);
    expect(params.has('fileId')).toBe(false);
    expect(params.has('email')).toBe(false);
  });

  test('baseUrl 省略時は配信 URL を使う', () => {
    const url = buildPickerUrl({ redirectUri: REDIRECT_URI });
    expect(url.startsWith(`${PICKER_PAGE_URL}#`)).toBe(true);
  });
});

describe('isExtensionRedirectUri', () => {
  test('chromiumapp.org のリダイレクト URI を受け入れる', () => {
    expect(isExtensionRedirectUri(REDIRECT_URI)).toBe(true);
    // パス無し（末尾スラッシュのみ）も許容する
    expect(isExtensionRedirectUri('https://bckokafmjighegpjiocopkagghppnjld.chromiumapp.org/')).toBe(
      true
    );
  });

  test('外部サイトへの誘導を弾く（オープンリダイレクト防止）', () => {
    expect(isExtensionRedirectUri('https://evil.example.com/')).toBe(false);
    // http（非 TLS）
    expect(isExtensionRedirectUri('http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/')).toBe(
      false
    );
    // サブドメインを装った別ホスト
    expect(
      isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.test/')
    ).toBe(false);
    // 拡張 ID の文字種（a〜p）・長さ違い
    expect(isExtensionRedirectUri('https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/')).toBe(
      false
    );
    expect(isExtensionRedirectUri('https://abc.chromiumapp.org/')).toBe(false);
    // a〜p 32 文字の正当な形式だが、自拡張の ID とは別の拡張機能を装っている
    expect(
      isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/')
    ).toBe(false);
    // パス区切りが無い（ホスト名の続きを装える）
    expect(isExtensionRedirectUri('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org')).toBe(
      false
    );
    expect(isExtensionRedirectUri('')).toBe(false);
  });
});

describe('parsePickerRedirect', () => {
  test('選択されたファイル ID を返す', () => {
    expect(parsePickerRedirect(`${REDIRECT_URI}#picked=sheet-1`)).toEqual({ picked: 'sheet-1' });
  });

  test('URL エンコードされた ID を復元する', () => {
    expect(parsePickerRedirect(`${REDIRECT_URI}#picked=a%2Fb`)).toEqual({ picked: 'a/b' });
  });

  test('キャンセルを識別する', () => {
    expect(parsePickerRedirect(`${REDIRECT_URI}#cancelled=1`)).toBe('cancelled');
  });

  test('解釈できない戻り値は null', () => {
    expect(parsePickerRedirect(`${REDIRECT_URI}#`)).toBeNull();
    expect(parsePickerRedirect(REDIRECT_URI)).toBeNull();
    expect(parsePickerRedirect(`${REDIRECT_URI}#picked=`)).toBeNull();
    expect(parsePickerRedirect(`${REDIRECT_URI}#cancelled=0`)).toBeNull();
    expect(parsePickerRedirect('not a url')).toBeNull();
  });
});
