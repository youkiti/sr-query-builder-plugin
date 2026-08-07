# ストア掲載「詳細な説明」原稿

Chrome ウェブストア デベロッパーダッシュボードの「掲載情報」→「詳細な説明」欄へそのまま貼り付ける原稿です。更新するときは、[hosted/index.html](../../hosted/index.html) / [hosted/help.html](../../hosted/help.html) / [src/_locales/ja/messages.json](../../src/_locales/ja/messages.json) と [src/_locales/en/messages.json](../../src/_locales/en/messages.json) の `extDescription` と矛盾しないよう整合を取ってください。

## 日本語（ja description フィールド用）

```
研究プロトコルから PubMed 検索式のドラフト作成・検証・各データベース向け変換までを支援する Chrome 拡張です。

■ご利用の流れ
1. 研究プロトコル（リサーチクエスチョン・PICO 等の組入/除外基準）を手入力するか、Markdown（.md）ファイルから取り込みます。
2. 生成 AI（既定は Gemini。OpenRouter 経由で他のモデルへ切り替えることも可能です）が、プロトコルから PubMed 検索式のドラフトを作成します。
3. NCBI E-utilities を使い、ブロックごとのヒット数・シード論文の捕捉率・MeSH 用語をライブで検証します。
4. （実験的機能）現在の検索式の境界にありそうなシード論文候補を対話的に提示し、include / exclude の判定を通じて検索式の更新案を得られます。
5. 最終的な検索式を CENTRAL / Embase(Dialog) / ClinicalTrials.gov / ICTRP 向けに変換して出力し、PubMed の nbib ダウンロードなど各データベースでの操作先へご案内します。

■ご用意いただくもの
- 生成 AI の API キー（Gemini、または切り替えた場合は OpenRouter）。ご自身で取得したキーを拡張の設定画面に保存して使う BYOK（Bring Your Own Key）方式で、本拡張が API キーを提供することはありません。
- NCBI API キー（任意）。検証時のレート制限を緩和したい場合に設定します。
- Google アカウント。プロトコル・検索式・検証結果などのデータは、開発者のサーバーではなく、利用者ご自身の Google アカウントの Google スプレッドシートと Google Drive に保存されます。

■対応していないこと
文献のスクリーニング・重複除去・全文 PDF の取得・PRISMA 用の記述ブロック生成・Rayyan との連携は行いません。各データベースでのダウンロード操作も自動化しておらず、操作先のページまでのご案内にとどまります。

MIT ライセンスのオープンソースソフトウェアで、ソースコードは GitHub で公開しています（https://github.com/youkiti/sr-query-builder-plugin）。
```

## English (for the en description field)

```
A Chrome extension that helps you draft, validate, and convert a PubMed search strategy from a research protocol.

How it works
1. Enter your research protocol (research question, PICO-style eligibility criteria, etc.) by hand, or import it from a Markdown (.md) file.
2. Generative AI (Gemini by default; you can switch to other models via OpenRouter) drafts a PubMed search strategy from the protocol.
3. NCBI E-utilities validate the draft live: per-block hit counts, seed-paper capture rate, and MeSH terms.
4. (Experimental) Borderline seed-paper candidates near the edge of the current query are presented interactively; your include/exclude decisions produce suggested updates to the query.
5. The finalized query is converted for CENTRAL, Embase (Dialog), ClinicalTrials.gov, and ICTRP, with guidance to each database's own download steps (e.g., PubMed's nbib download).

What you'll need
- An API key for the generative AI provider (Gemini, or OpenRouter if you switch). This extension uses a BYOK (Bring Your Own Key) model: you obtain and save your own key in the options screen, and the extension does not supply one.
- An NCBI API key (optional), to raise the rate limit during validation.
- A Google account. Your protocol, search strategy, and validation results are stored in your own Google Sheets and Google Drive, not on a developer-operated server.

What it doesn't do
It does not perform screening, deduplication, full-text PDF retrieval, PRISMA flow-diagram text generation, or Rayyan integration. Downloading from each database is not automated either; the extension only guides you to where to do it.

It is MIT-licensed open source; the source code is available on GitHub (https://github.com/youkiti/sr-query-builder-plugin).
```
