# r1-mindfulness-smoking: 人手判断が必要な行（3 件、参照先からの伝播を含む）

## 行 14

元の式: (meditat* or mindful* or "relaxation* mind body" or "body mind").mp.

- 理由: "relaxation* mind body": unknown truncated stems relaxation*

## 行 17

元の式: 9 or 10 or 11 or 12 or 13 or 14 or 15 or 16

- 理由: unsupported reference 14

## 行 18

元の式: 8 and 17

- 理由: unsupported reference 17

## 変換記録（未解決のため計測禁止）

# r1-mindfulness-smoking: Ovid → PubMed

明示ブリーフを優先: 切り捨てを伴う近接は AND、副標目は exp がない限り noexp。未知の ? は省略して要人手判断。

句内の切り捨ては known-words.json の完結した語に限り単複化し、それ以外は人手判断まで出力しない。

`.mp.` は tiab を出し、大小文字を除いて許可リストに完全一致し、切り捨てを含まない語だけ Mesh を追加する。

## 1

元: exp Smoking Cessation/

```text
"Smoking Cessation"[Mesh]
```

近似記録なし

## 2

元: exp "Tobacco Use Disorder"/

```text
"Tobacco Use Disorder"[Mesh]
```

近似記録なし

## 3

元: (SMOKING* or TOBACCO or "TOBACCO USE DISORDER*" or "TOBACCO USE CESSATION*" or NICOTINE*).mp.

```text
(SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])
```

- mesh_dropped: SMOKING*: truncated or not in MeSH allowlist
- mesh_dropped: "TOBACCO USE DISORDER*": truncated or not in MeSH allowlist
- phrase_truncation: "TOBACCO USE DISORDER*": singular/plural expansion requires known complete words
- mesh_dropped: "TOBACCO USE CESSATION*": truncated or not in MeSH allowlist
- phrase_truncation: "TOBACCO USE CESSATION*": singular/plural expansion requires known complete words
- mesh_dropped: NICOTINE*: truncated or not in MeSH allowlist

## 4

元: (SMOKING CESSATION or ANTISMOK*).ti,ab.

```text
("SMOKING CESSATION"[tiab] OR ANTISMOK*[tiab])
```

近似記録なし

## 5

元: (quit* or smok* or nonsmok* or cigar* or tobacco* or nicotine*).ti.

```text
(quit*[ti] OR smok*[ti] OR nonsmok*[ti] OR cigar*[ti] OR tobacco*[ti] OR nicotine*[ti])
```

近似記録なし

## 6

元: smoking cessation.mp.

```text
("smoking cessation"[tiab] OR "smoking cessation"[Mesh])
```

近似記録なし

## 7

元: exp "Tobacco Use Cessation"/

```text
"Tobacco Use Cessation"[Mesh]
```

近似記録なし

## 8

元: 1 or 2 or 3 or 4 or 5 or 6 or 7

```text
(("Smoking Cessation"[Mesh]) OR ("Tobacco Use Disorder"[Mesh]) OR ((SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])) OR (("SMOKING CESSATION"[tiab] OR ANTISMOK*[tiab])) OR ((quit*[ti] OR smok*[ti] OR nonsmok*[ti] OR cigar*[ti] OR tobacco*[ti] OR nicotine*[ti])) OR (("smoking cessation"[tiab] OR "smoking cessation"[Mesh])) OR ("Tobacco Use Cessation"[Mesh]))
```

近似記録なし

## 9

元: exp mindfulness/

```text
"mindfulness"[Mesh]
```

近似記録なし

## 10

元: exp meditation/

```text
"meditation"[Mesh]
```

近似記録なし

## 11

元: exp "Mind Body Therapies"/

```text
"Mind Body Therapies"[Mesh]
```

近似記録なし

## 12

元: exp "Mind Body Relations, Metaphysical"/

```text
"Mind Body Relations, Metaphysical"[Mesh]
```

近似記録なし

## 13

元: exp Breathing Exercises/

```text
"Breathing Exercises"[Mesh]
```

近似記録なし

## 14

元: (meditat* or mindful* or "relaxation* mind body" or "body mind").mp.

```text
(meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])
```

- mesh_dropped: meditat*: truncated or not in MeSH allowlist
- mesh_dropped: mindful*: truncated or not in MeSH allowlist
- mesh_dropped: "relaxation* mind body": truncated or not in MeSH allowlist
- phrase_truncation: "relaxation* mind body": singular/plural expansion requires known complete words
- unsupported: "relaxation* mind body": unknown truncated stems relaxation*
- mesh_dropped: "body mind": truncated or not in MeSH allowlist

## 15

元: (Samadhi or Samapatti).mp.

```text
(Samadhi[tiab] OR Samapatti[tiab])
```

- mesh_dropped: Samadhi: truncated or not in MeSH allowlist
- mesh_dropped: Samapatti: truncated or not in MeSH allowlist

## 16

元: (acceptance adj2 commitment).ti,ab.

```text
"acceptance commitment"[tiab:~1]
```

近似記録なし

## 17

元: 9 or 10 or 11 or 12 or 13 or 14 or 15 or 16

```text
(("mindfulness"[Mesh]) OR ("meditation"[Mesh]) OR ("Mind Body Therapies"[Mesh]) OR ("Mind Body Relations, Metaphysical"[Mesh]) OR ("Breathing Exercises"[Mesh]) OR ((meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])) OR ((Samadhi[tiab] OR Samapatti[tiab])) OR ("acceptance commitment"[tiab:~1]))
```

- unsupported: unsupported reference 14

## 18

元: 8 and 17

```text
(((("Smoking Cessation"[Mesh]) OR ("Tobacco Use Disorder"[Mesh]) OR ((SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])) OR (("SMOKING CESSATION"[tiab] OR ANTISMOK*[tiab])) OR ((quit*[ti] OR smok*[ti] OR nonsmok*[ti] OR cigar*[ti] OR tobacco*[ti] OR nicotine*[ti])) OR (("smoking cessation"[tiab] OR "smoking cessation"[Mesh])) OR ("Tobacco Use Cessation"[Mesh]))) AND ((("mindfulness"[Mesh]) OR ("meditation"[Mesh]) OR ("Mind Body Therapies"[Mesh]) OR ("Mind Body Relations, Metaphysical"[Mesh]) OR ("Breathing Exercises"[Mesh]) OR ((meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])) OR ((Samadhi[tiab] OR Samapatti[tiab])) OR ("acceptance commitment"[tiab:~1]))))
```

- unsupported: unsupported reference 17

## Unsupported（人手判断が必要）

- 14: "relaxation* mind body": unknown truncated stems relaxation*

- 17: unsupported reference 14

- 18: unsupported reference 17

## 人手期待値との差分

比較では大小文字・冗長括弧・AND/OR 内の順序と重複を正規化し、履歴参照を完全展開する。

### 3

期待: (smoking*[tiab] OR tobacco[tiab] OR "tobacco use disorder"[tiab] OR "tobacco use disorders"[tiab] OR "tobacco use cessation"[tiab] OR nicotine*[tiab] OR "Tobacco"[Mesh] OR "Nicotine"[Mesh])

実際:

```text
(SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 8

期待: (#1 OR #2 OR #3 OR #4 OR #5 OR #6 OR #7)

実際:

```text
(("Smoking Cessation"[Mesh]) OR ("Tobacco Use Disorder"[Mesh]) OR ((SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])) OR (("SMOKING CESSATION"[tiab] OR ANTISMOK*[tiab])) OR ((quit*[ti] OR smok*[ti] OR nonsmok*[ti] OR cigar*[ti] OR tobacco*[ti] OR nicotine*[ti])) OR (("smoking cessation"[tiab] OR "smoking cessation"[Mesh])) OR ("Tobacco Use Cessation"[Mesh]))
```

原因の推測: 参照先の差が伝播

### 11

期待: "Mind-Body Therapies"[Mesh]

実際:

```text
"Mind Body Therapies"[Mesh]
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 12

期待: "Mind-Body Relations, Metaphysical"[Mesh]

実際:

```text
"Mind Body Relations, Metaphysical"[Mesh]
```

原因の推測: 規則による機械変換と、人手での語形・語幹・MeSH選択が異なる

### 14

期待: (meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab] OR "relaxation mind body"[tiab])

実際:

```text
(meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])
```

原因の推測: 未対応のワイルドカードまたは句内語幹を省略・要人手判断

### 17

期待: (#9 OR #10 OR #11 OR #12 OR #13 OR #14 OR #15 OR #16)

実際:

```text
(("mindfulness"[Mesh]) OR ("meditation"[Mesh]) OR ("Mind Body Therapies"[Mesh]) OR ("Mind Body Relations, Metaphysical"[Mesh]) OR ("Breathing Exercises"[Mesh]) OR ((meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])) OR ((Samadhi[tiab] OR Samapatti[tiab])) OR ("acceptance commitment"[tiab:~1]))
```

原因の推測: 参照先の差が伝播

### 18

期待: #8 AND #17

実際:

```text
(((("Smoking Cessation"[Mesh]) OR ("Tobacco Use Disorder"[Mesh]) OR ((SMOKING*[tiab] OR (TOBACCO[tiab] OR TOBACCO[Mesh]) OR ("TOBACCO USE DISORDER"[tiab] OR "TOBACCO USE DISORDERs"[tiab]) OR ("TOBACCO USE CESSATION"[tiab] OR "TOBACCO USE CESSATIONs"[tiab]) OR NICOTINE*[tiab])) OR (("SMOKING CESSATION"[tiab] OR ANTISMOK*[tiab])) OR ((quit*[ti] OR smok*[ti] OR nonsmok*[ti] OR cigar*[ti] OR tobacco*[ti] OR nicotine*[ti])) OR (("smoking cessation"[tiab] OR "smoking cessation"[Mesh])) OR ("Tobacco Use Cessation"[Mesh]))) AND ((("mindfulness"[Mesh]) OR ("meditation"[Mesh]) OR ("Mind Body Therapies"[Mesh]) OR ("Mind Body Relations, Metaphysical"[Mesh]) OR ("Breathing Exercises"[Mesh]) OR ((meditat*[tiab] OR mindful*[tiab] OR "body mind"[tiab])) OR ((Samadhi[tiab] OR Samapatti[tiab])) OR ("acceptance commitment"[tiab:~1]))))
```

原因の推測: 参照先の差が伝播
