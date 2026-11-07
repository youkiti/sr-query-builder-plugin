<!-- ヘルプ相談の処理の流れと送信範囲、固定設定と未検証の範囲を説明する。 -->
# ヘルプ相談の土台

キー不要の端末内検索 → AI による最大3小節の選択 → 選んだ本文で一問一答 → 未解決なら公開 Issue の下書き、の部品です。
アプリの「?」メニューから、`src/app/guide/consult/` の小窓を遅延読み込みして使います。
会話履歴、運営サーバ、自動再試行、Drive・Sheets・LLMApiLog への記録はありません。

- `loadHelpSections(lang)` は `hosted/help.html` からビルド時に作る言語別データを動的 import します。
  画面から読み込まれると、webpack が `chunks/help-sections-ja.js` と `chunks/help-sections-en.js` を別のチャンクとして出力します。
- `searchHelpSections` は NFKC と小文字化、英数字の語・日本語の文字二つ組で検索し、when を3、title を2、body を1で重み付けします。
- `chooseConsultProvider` は現在の実効モデルの社にキーがあれば優先し、なければ Anthropic → Gemini → OpenRouter の順で選びます。
  呼び出し元が既存のキー取得関数などでキーと設定済みの社を用意します。
- 固定モデルは Gemini `gemini-3.5-flash-lite`、Anthropic `claude-haiku-5-5`、OpenRouter `deepseek/deepseek-v4-flash` です。
- `consultHelp` は質問・言語・小節・社・キーを受け取り、任意ホストの許可を確認してから直接プロバイダを作ります。
  1回目は質問と各小節の id・title・sectionTitle・when だけを送り、2回目は質問と選んだ小節の title・body だけを送ります。
  本文の URL、他言語、動画リンク、こんなときの囲みはビルド時に除去します。
  キーはプロバイダの認証に使い、質問やヘルプのデータには入れません。
  成功時の answer は応答本文を加工せず返すため、表示時の扱いは呼び出し元で決めます。
- 指示文の版は `help-consult-v1`、出力上限は両段とも 8,192 トークンです。
  打ち切りは `truncated`、フィルタ・拒否と空本文は `invalid_response` とします。
  正常終了および null・未知の終了理由は、本文が空でなければ受け付けます。
  外部中止は `aborted`、既定60秒（`timeoutMs` で変更可）の全体タイムアウトは `timeout` です。
- `createIssueDraft` はメール・外部 URL・長いキー断片を伏せ、日英の公開注意と環境情報を付けます。
  題は100文字以内、エンコードした URL は8,000文字以内に収めます。

検証には偽の fetch と実物のヘルプを使います。
本物の API による回答品質・費用・モデルの利用可否の評価は、この作業では行っていません。
