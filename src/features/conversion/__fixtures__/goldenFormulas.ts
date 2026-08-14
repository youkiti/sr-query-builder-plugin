/**
 * DB 変換のゴールデンテスト用フィクスチャ。
 *
 * submodule `search-formula-developper`（Python 参照実装）は CI がチェックアウトしない
 * （.github/workflows/ci.yml が `actions/checkout@v4` を `submodules` 指定なしで呼んでおり、
 * 参照実装は本体の src/ や tests/ から一切参照されない前提のため）。
 * そのため、実式・期待値は**このファイルへコピーして固定**してある。
 * submodule 側を後から書き換えても、ここに埋め込んだ期待値は変化しない
 * （＝ CI で常に再現可能な回帰テストとして機能する）点に注意。
 */

/**
 * 実式フィクスチャ 1: 近接演算子の 3 パターン（tiab / Title / ad、距離あり・隣接）を
 * 1 本の検索式に含んだ実例。
 *
 * 出典: search-formula-developper/scripts/conversion/search_formula/proximity_test/all_database_search.md
 * （`search_converter.py` の `main()` が実際に生成・保存したファイルで、
 * 生成日時のコメントも含めてそのまま書き写している。CENTRAL / Dialog の期待値は
 * このファイルの `## Cochrane CENTRAL` / `## Dialog (Embase)` セクションをそのまま転記した
 * ものであり、Python の実出力そのもの）。
 */
export const TREMOR_PROXIMITY_PUBMED_MD = `# データベース別検索式

変換日時: 2025-05-14 08:24:28

## PubMed

\`\`\`
#1 "Essential Tremor"[Mesh]
#2 "tremor therapy"[tiab:~2]
#3 "deep brain"[Title:~0]
#4 "hospital university"[ad:~5]
#5 (#1 OR #2) AND (#3 OR #4)
\`\`\`
`;

/** Python `convert_to_central()` の実出力（上記ファイルより転記）。 */
export const TREMOR_PROXIMITY_EXPECTED_CENTRAL = `#1 [mh "Essential Tremor"]
#2 ("tremor" NEAR/2 "therapy"):ti,ab,kw
#3 ("deep" NEXT "brain"):ti
#4 ("hospital" NEAR/5 "university")
#5 (#1 OR #2) AND (#3 OR #4)`;

/** Python `convert_to_dialog()` の実出力（上記ファイルより転記）。 */
export const TREMOR_PROXIMITY_EXPECTED_DIALOG = `S1 EMB.EXACT.EXPLODE("Essential Tremor")
S2 TI,AB(tremor N/2 therapy)
S3 TI(deep W/1 brain)
S4 CS(hospital N/5 university)
S5 (S1 OR S2) AND (S3 OR S4)`;

/**
 * 実式フィクスチャ 2: PubMed 側の行番号が連番でない（#1, #3, #5, #7 と欠番がある）ケース。
 * 3-3（Dialog の #N → SN 1:1 置換の危険性）を再現する実データが submodule 内に
 * 見当たらなかったため、実務でありがちな「ブロックの手直しで欠番が生じる」状況を模して
 * このリポジトリで新規に作成した。MeSH（3-2 の Emtree 警告）・近接演算子（3-1）・
 * 欠番 ID の組み合わせ（3-3）を 1 本で確認できる。
 *
 * 期待値は、submodule 側の Python 実装（search_converter.py）の
 * `convert_to_central` / `convert_to_dialog` を直接呼び出して生成した実出力をそのまま
 * 転記している（ファイルは一切書き換えていない。read-only import による関数呼び出しのみ）。
 * 実行コマンド:
 *   cd search-formula-developper/scripts/conversion && python3 - <<'PY'
 *   from search_converter import convert_to_central, convert_to_dialog
 *   pubmed = '''#1 "Diabetes Mellitus"[Mesh]
 *   #3 "glucose control"[tiab:~3]
 *   #5 "metformin therapy"[tiab]
 *   #7 (#1 AND #3) OR #5'''
 *   print(convert_to_central(pubmed))
 *   print(convert_to_dialog(pubmed))
 *   PY
 */
export const GAPPED_ID_PUBMED_MD = `# ゴールデンフィクスチャ: 非連番 ID

## PubMed

\`\`\`
#1 "Diabetes Mellitus"[Mesh]
#3 "glucose control"[tiab:~3]
#5 "metformin therapy"[tiab]
#7 (#1 AND #3) OR #5
\`\`\`
`;

/** Python `convert_to_central()` の実出力（上記コマンドで生成）。 */
export const GAPPED_ID_EXPECTED_CENTRAL = `#1 [mh "Diabetes Mellitus"]
#3 ("glucose" NEAR/3 "control"):ti,ab,kw
#5 "metformin therapy":ti,ab,kw
#7 (#1 AND #3) OR #5`;

/** Python `convert_to_dialog()` の実出力（上記コマンドで生成）。 */
export const GAPPED_ID_EXPECTED_DIALOG = `S1 EMB.EXACT.EXPLODE("Diabetes Mellitus")
S2 TI,AB(glucose N/3 control)
S3 (TI("metformin therapy") OR AB("metformin therapy"))
S4 (S1 AND S2) OR S3`;
