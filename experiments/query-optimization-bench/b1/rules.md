# B1: Ovid MEDLINE → PubMed 変換規則（凍結版）

Cochrane の元検索式（Ovid 構文）を PubMed で実行するための変換規則。
**成績（held-out 捕捉）を見る前に確定し、以後は変更しない。**

これは「元の検索の再現」ではなく、**文書化された近似を含む再構成**である。
下の「近似」に該当した行は各ケースの `b1.md` に列挙する。

## 1. 機械的に対応が付く規則

| Ovid | PubMed | 備考 |
|---|---|---|
| `exp X/` | `"X"[Mesh]` | PubMed の `[Mesh]` は既定で下位語を展開する |
| `X/` | `"X"[Mesh:noexp]` | 展開しない |
| `X/su` 等の副標目 | `"X/subheading"[Mesh]` | 例 `Vascular Diseases/su` → `"Vascular Diseases/surgery"[Mesh]` |
| `.tw.` | `[tiab]` | Ovid の tw = title+abstract |
| `.ti.` | `[ti]` | |
| `.ti,ab.` | `[tiab]` | |
| `.ab.` | `[tiab]` | PubMed に抄録単独のタグは無い（**近似: タイトルも含む**） |
| `.kw.` / `.kf.` | `[ot]` | キーワード |
| `.pt.` | `[pt]` | |
| `.sh.` | `[sh]` | |
| `.mp.` | `([tiab] OR [Mesh])` | Ovid の mp = title, abstract, heading word, keyword 等（**近似**） |
| `*`（語尾） | `*` | |
| `or/12-28` | `(#12 OR … OR #28)` を完全展開 | 範囲参照は必ず展開する |
| `12 and 29` | 参照先を括弧付きで完全展開 | PubMed の `#n` 履歴参照には依存しない |

## 2. 近似が要る箇所（PubMed の制約）

1. **`?`（1 文字ワイルドカード）は PubMed に無い** → 綴りを列挙して OR にする
   - `non?proliferative` → `(nonproliferative OR "non proliferative")`
   - `neo?vasculari*` → `(neovasculari* OR "neo vasculari*")` ※句内の `*` は下記 3 の制約を受けるため
     実際には `(neovascularis* OR neovasculariz*)` のように語単位へ展開する
   - `h?emorrhage*` → `(hemorrhage* OR haemorrhage*)`
2. **近接演算子と切り捨ての併用が不可**: PubMed の `"a b"[tiab:~N]` は**引用句の中で `*` を使えない**。
   `(risk* adj5 progress*)` のような行は次のいずれかに落とす（採用した方を `b1.md` に明記）:
   - (a) 語形を列挙して近接を保つ: `("risk progression"[tiab:~4] OR "risks progression"[tiab:~4] OR …)`
   - (b) 近接を諦めて AND に落とす: `(risk*[tiab] AND progress*[tiab])` — **感度は上がり特異度は下がる**
   - 原則 (a) を使い、語形が 6 通りを超える場合のみ (b) にする
3. **`adjN` の距離換算**: Ovid の `adjN` は「間に最大 N−1 語」。PubMed の `[tiab:~M]` は「間に最大 M 語」。
   よって **`adjN` → `~(N−1)`**（例: `adj2` → `~1`、`adj5` → `~4`）
4. **近接演算子が使えるフィールドは `[tiab]` / `[ti]` / `[ad]` のみ**。それ以外に adj があれば AND に落として記録する
5. **`.mp.` の MeSH 部分**: 同じブロック内に対応する `[Mesh]` 行が既にある場合は重複させない（結果集合は変わらない）

## 3. 検証の手順（ヒット数の桁一致は根拠にしない）

1. 行ごとに「フィールド指定・展開の有無・近接距離・Boolean 結合」を 1 対 1 で突き合わせる
2. `[Mesh]` に書いた見出し語が**実在する MeSH 見出しか**を `esearch db=mesh` で 1 語ずつ確認する
   （存在しない見出しは PubMed が黙って全フィールド検索に落とすため、気づかずに集合が変わる）
3. 変換後の各ブロックのヒット数を記録する。**Cochrane 報告値との一致は求めない**
   （検索日・索引の更新で当然ずれる。桁違いの乖離があるブロックだけを再点検する）
4. **held-out の捕捉率を見て変換を調整しない。** 調整したくなった場合は、その事実と内容を報告に書く
