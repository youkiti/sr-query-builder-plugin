/**
 * Google Picker（apis.google.com/js/api.js）と Google Identity Services（accounts.google.com/gsi/client）の
 * ambient 宣言。どちらも公式の型定義パッケージが無い（GIS は @types/google.accounts があるが、
 * 本ページが使うのは initTokenClient / revoke の 2 つだけなので依存を増やさず手書きする）。
 *
 * 使用しているメンバーだけを宣言する。増やすときは公式ドキュメントの綴りを確認すること
 * （例: login_hint を hint と書いても TypeScript は通るが、実行時には無視される）。
 */

declare namespace google.picker {
  enum Action {
    PICKED = 'picked',
    CANCEL = 'cancel',
  }
  enum ViewId {
    SPREADSHEETS = 'spreadsheets',
  }
  enum Response {
    ACTION = 'action',
    DOCUMENTS = 'docs',
  }
  enum Document {
    ID = 'id',
    NAME = 'name',
    MIME_TYPE = 'mimeType',
  }

  class DocsView {
    constructor(viewId: ViewId);
    /** 表示対象を指定 ID のファイルだけに絞る。「事前フォーカス」ではない点に注意 */
    setFileIds(fileIds: string): DocsView;
    /**
     * false で「共有アイテム」ビューになる。既定（未指定）はマイドライブ配下のみが対象で、
     * 共有されただけでマイドライブに追加していないファイルは一覧にも検索結果にも出てこない。
     */
    setOwnedByMe(ownedByMe: boolean): DocsView;
    /** Picker のタブ見出し。既定のままだと 2 枚のビューが同名タブになり見分けが付かない */
    setLabel(label: string): DocsView;
  }

  class PickerBuilder {
    setDeveloperKey(key: string): PickerBuilder;
    setAppId(appId: string): PickerBuilder;
    setOAuthToken(token: string): PickerBuilder;
    addView(view: DocsView): PickerBuilder;
    setLocale(locale: string): PickerBuilder;
    setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
    build(): Picker;
  }

  interface Picker {
    setVisible(visible: boolean): void;
  }
  interface PickerDocument {
    [Document.ID]?: string;
    [Document.NAME]?: string;
    [Document.MIME_TYPE]?: string;
  }
  interface PickerResponse {
    [Response.ACTION]?: Action;
    [Response.DOCUMENTS]?: PickerDocument[];
  }
}

declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token: string;
    /** 実際に付与されたスコープ（空白区切り）。include_granted_scopes の効果確認に使う */
    scope: string;
    error?: string;
  }

  interface TokenClientConfig {
    client_id: string;
    scope: string;
    /** アカウント選択の初期値。正式なパラメータ名は login_hint（hint は非推奨） */
    login_hint?: string;
    /**
     * 既定は true で、過去に許可したスコープを新しいトークンが引き継ぐ。
     * 本拡張は drive.file 以上を要求しないので、明示的に false を渡して引き継ぎを止める。
     */
    include_granted_scopes?: boolean;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type: string }) => void;
  }

  interface TokenClient {
    requestAccessToken(overrides?: { prompt?: string }): void;
  }

  function initTokenClient(config: TokenClientConfig): TokenClient;
  function revoke(token: string, callback?: () => void): void;
  /**
   * granular consent（Google が個別スコープごとに許可/拒否させる同意画面）では、
   * ユーザーが要求したスコープの一部だけを許可できる。`TokenResponse.scope` を自前で
   * 文字列比較する代わりに、公式 API で「要求した全スコープが付与されたか」を確認する。
   */
  function hasGrantedAllScopes(tokenResponse: TokenResponse, ...scopes: string[]): boolean;
}

declare const gapi: { load(api: string, callback: () => void): void };
