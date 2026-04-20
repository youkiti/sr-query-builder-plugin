# experiments/

LLM プロンプトの実験・検証用スクリプトを置くディレクトリ。
[docs/architecture.md §1](../docs/architecture.md) で「実装フェーズで追加」と
宣言されていた枠を占有する。

## 位置づけ

本ディレクトリのスクリプトは Chrome 拡張本体には同梱しない：

- `src/` 配下は拡張のランタイムコードのみ
- `experiments/` は **手元で LLM に投げて応答を見るための使い捨てスクリプト**
- 実行結果（生 prompt・response）は `.gitignore` で無視するか `fixtures/` に選択的に残す

## 想定する実験対象

[docs/requirements.md §11.2](../docs/requirements.md) で「実装時に Claude が起案 →
開発者がレビュー・修正」と決めた以下のプロンプトを、ここで手動検証する：

| skill | プロンプト | 検証したい点 |
|---|---|---|
| `extract-protocol` | `src/features/formula/skills/extractProtocol.ts` | 日本語 / 英語プロトコルから RQ・ブロック・結合式を安定抽出できるか |
| `block-designer` | `src/features/formula/skills/blockDesigner.ts` | 1 ブロック記述から MeSH 要件 / フリーワード要件へ適切に振り分かれるか |
| `mesh-suggester` | `src/features/formula/skills/meshSuggester.ts` | seed MeSH を踏まえた上位 MeSH を提案できるか |
| `freeword-designer` | `src/features/formula/skills/freewordDesigner.ts` | MeSH 未付与新規論文を拾う tiab 語彙が出るか |
| `filter-designer` | `src/features/formula/skills/filterDesigner.ts` | プロトコルに無いフィルタ（English[lang] 等）を勝手に入れないか |
| `pick-boundary-cases` | `src/features/formula/skills/pickBoundaryCases.ts` | 50 件中 5 件の境界事例が毎回「素直すぎない」ものになっているか |
| `improve-block` | `src/features/formula/skills/improveBlock.ts` | 1 行改善要求に対し、感度・特異度が過度に寄らない提案が返るか |

## 推奨ディレクトリ構造（スクリプトを追加するとき）

```
experiments/
├── README.md                  ← 本ファイル
├── fixtures/
│   ├── protocols/*.md          # 入力用プロトコル（実データは匿名化）
│   └── seeds/*.txt             # PMID リスト
├── prompt-extract-protocol.ts  # 単発実行スクリプト（ts-node で実行）
├── prompt-block-designer.ts
└── ...
```

各スクリプトは `tsx` or `ts-node` で走らせ、`.env` から `GEMINI_API_KEY` を
読み取る。サンプル雛形：

```ts
// experiments/prompt-extract-protocol.ts（実装時に追加する想定）
import 'dotenv/config';
import { GeminiProvider } from '../src/lib/llm';
import { extractProtocol } from '../src/features/formula/skills/extractProtocol';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY が未設定です');

const provider = new GeminiProvider({ apiKey, fetch: globalThis.fetch });
const plainText = await (await fetch('file://.../protocol.md')).text();
const draft = await extractProtocol({ plainText }, provider);
console.log(JSON.stringify(draft, null, 2));
```

## 注意

- **本番ビルドに含めない**: webpack のエントリ・CopyPlugin いずれにも入っていない。
  jest/eslint も `src/` と `tests/` しか見ていない（ルート `.eslintrc.cjs` を確認）
- **API コスト**: 手動実行なので人間の目でコスト管理する。本拡張内の `LLMApiLog`
  機能と違い、ここでの呼び出しは監査ログに残らない
- **機密扱い**: 実プロトコル PDF を `fixtures/` に入れる場合はリポジトリに push しない
