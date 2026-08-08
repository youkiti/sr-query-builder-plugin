/**
 * デモビルド専用の架空論文コーパス（12 本）。
 *
 * 正典ファイル: 動画収録シナリオ（成人 ARDS に対する ECMO は生存率を改善するか）で
 * 登場するすべての論文はここでしか定義しない。esearch のヒット数・efetch の中身・
 * シード捕捉率はすべて `queryEngine.ts` の評価関数がこのコーパスを走査して導出する
 * （ハードコードした件数は持たない。video/REQUIREMENTS.md §6-2）。
 *
 * PMID は現在の PubMed が到達していない番号帯（90000001〜）を使用し、
 * 実在の論文・実在の PMID とは一切対応させない。
 *
 * 各論文の設計意図（シナリオとの対応）:
 * - 90000001〜90000005: 初期登録シード 5 本（すべて RCT）。
 *   90000005 だけ本文が "ECMO" / "extracorporeal membrane oxygenation" を使わず
 *   "extracorporeal life support" と表記する（MeSH には Extracorporeal Membrane
 *   Oxygenation が付与されている）。ブロック #2（ECMO）の初期式はフリーワードのみで
 *   MeSH タグを持たないため、90000005 だけ検索式が取りこぼす（捕捉率 80%）。
 * - 90000006〜90000008: 現式の外側（margin）に落ちる境界事例候補。
 *   ARDS を "acute hypoxemic respiratory failure" と言い換える等、ブロック #1/#2 の
 *   語彙から一段広い表現を使う。90000006 は 90000005 と同じ欠落パターン
 *   （ARDS 表記は一致・ECMO 表記のみ不一致）を持ち、対話的シード拡張で include すると
 *   ブロック #2 への MeSH 追加だけで 100% 捕捉に届く「模範解答」の候補として設計している。
 * - 90000009〜90000012: 一部の軸だけ一致するデコイ（無関係疾患 / 小児・観察研究 /
 *   ECMO はあるが ARDS ではない症例報告 / ARDS の RCT だが ECMO を扱わない）。
 *   ブロック単体・RCT フィルタそれぞれが実際に絞り込みとして機能していることを示す。
 */

/** efetch が返す MeSH 詳細（構造化）。デモでは簡略化しすべて MajorTopic・qualifier なしとする。 */
export interface DemoMeshDetail {
  descriptor: string;
  majorTopic: boolean;
  qualifiers: never[];
}

export interface DemoPaper {
  pmid: string;
  title: string;
  abstract: string;
  year: number;
  journal: string;
  authors: string[];
  volume: string;
  issue: string;
  pages: string;
  doi: string | null;
  /** MeSH descriptor 名一覧（単純化のためチェックタグは持たせない） */
  meshHeadings: string[];
}

function paper(input: Omit<DemoPaper, 'meshHeadings'> & { mesh: string[] }): DemoPaper {
  const { mesh, ...rest } = input;
  return { ...rest, meshHeadings: mesh };
}

/** シード論文（初期登録）5 本の PMID。source=initial として #/seeds で登録する対象。 */
export const SEED_PMIDS = [
  '90000001',
  '90000002',
  '90000003',
  '90000004',
  '90000005',
] as const;

/**
 * 対話的シード拡張（#/expand）で include すると捕捉率 100% への模範解答になる PMID。
 * 90000005 と同じ「ECMO 本文表記なし・MeSH あり」という欠落パターンを持つ。
 */
export const RECOMMENDED_BOUNDARY_INCLUDE_PMID = '90000006';

export const DEMO_CORPUS: readonly DemoPaper[] = [
  paper({
    pmid: '90000001',
    title:
      'Early extracorporeal membrane oxygenation for adult patients with severe acute respiratory distress syndrome: a randomized controlled trial',
    abstract:
      'In this randomized controlled trial, adult patients with severe acute respiratory distress syndrome (ARDS) were assigned to early venovenous ECMO or conventional mechanical ventilation. The primary outcome was 60-day survival.',
    year: 2019,
    journal: 'J Crit Care Med (fictional)',
    authors: ['Tanaka K', 'Suzuki M'],
    volume: '12',
    issue: '3',
    pages: '201-210',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation', 'Respiration, Artificial'],
  }),
  paper({
    pmid: '90000002',
    title:
      'Extracorporeal membrane oxygenation versus conventional mechanical ventilation in adult ARDS: a multicenter randomized trial',
    abstract:
      'We conducted a multicenter randomized trial comparing extracorporeal membrane oxygenation with conventional ventilation in adults with ARDS. Survival to hospital discharge was the primary endpoint.',
    year: 2020,
    journal: 'J Crit Care Med (fictional)',
    authors: ['Yamamoto R'],
    volume: '13',
    issue: '1',
    pages: '55-64',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000003',
    title:
      'ECMO for refractory hypoxemia in acute respiratory distress syndrome (ARDS): a randomised controlled trial',
    abstract:
      'Adult patients with ARDS and refractory hypoxemia were randomised to receive ECMO or standard care. Ninety-day survival did not differ significantly between groups.',
    year: 2021,
    journal: 'Intensive Care Trials (fictional)',
    authors: ['Sato H', 'Kobayashi T'],
    volume: '5',
    issue: '2',
    pages: '88-97',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000004',
    title: 'Venovenous ECMO in adult patients with ARDS: a randomized trial of survival outcomes',
    abstract:
      'This randomized trial evaluated venovenous ECMO in adult ARDS patients, focusing on 28-day and 90-day survival as co-primary outcomes.',
    year: 2022,
    journal: 'Intensive Care Trials (fictional)',
    authors: ['Watanabe S'],
    volume: '6',
    issue: '4',
    pages: '301-312',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000005',
    title: 'Venovenous extracorporeal life support for adult patients with ARDS: a randomized trial',
    abstract:
      'Adult patients with ARDS were randomized to venovenous extracorporeal life support versus conventional therapy, with 28-day survival as the primary outcome.',
    year: 2023,
    journal: 'Intensive Care Trials (fictional)',
    authors: ['Ito Y', 'Nakamura J'],
    volume: '7',
    issue: '1',
    pages: '10-19',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000006',
    title: 'Extracorporeal life support in adult ARDS: a randomized trial from a second treatment network',
    abstract:
      'In this randomized trial, adult patients with ARDS received venovenous extracorporeal life support or standard mechanical ventilation at a second network of centers.',
    year: 2023,
    journal: 'Intensive Care Trials (fictional)',
    authors: ['Kimura A'],
    volume: '7',
    issue: '3',
    pages: '150-159',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000007',
    title:
      'Randomized trial of extracorporeal life support in adults with acute hypoxemic respiratory failure due to severe pneumonia',
    abstract:
      'Adults with acute hypoxemic respiratory failure due to severe pneumonia were randomized to extracorporeal life support or usual care.',
    year: 2021,
    journal: 'Respiratory Support Journal (fictional)',
    authors: ['Hayashi N'],
    volume: '9',
    issue: '2',
    pages: '77-85',
    doi: null,
    mesh: ['Respiratory Insufficiency', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000008',
    title:
      'Effect of venovenous extracorporeal life support versus standard care on survival in hypoxemic respiratory failure: a randomized controlled trial',
    abstract:
      'Adults with acute hypoxemic respiratory failure were randomly assigned to venovenous extracorporeal life support or standard care in this randomized controlled trial.',
    year: 2022,
    journal: 'Respiratory Support Journal (fictional)',
    authors: ['Matsumoto D'],
    volume: '10',
    issue: '1',
    pages: '5-14',
    doi: null,
    mesh: ['Respiratory Insufficiency', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000009',
    title:
      'Effect of prone positioning on mortality in patients with sepsis-induced acute kidney injury: a randomized trial',
    abstract:
      'Patients with sepsis-induced acute kidney injury were randomized to prone positioning or usual care. This nephrology trial does not evaluate any form of mechanical ventilatory or respiratory support.',
    year: 2020,
    journal: 'Critical Care Nephrology (fictional)',
    authors: ['Fujita M'],
    volume: '4',
    issue: '2',
    pages: '40-48',
    doi: null,
    mesh: ['Sepsis', 'Acute Kidney Injury'],
  }),
  paper({
    pmid: '90000010',
    title:
      'Observational cohort study of extracorporeal membrane oxygenation use in pediatric acute respiratory distress syndrome',
    abstract:
      'This observational cohort study describes outcomes of extracorporeal membrane oxygenation use among children with acute respiratory distress syndrome. No randomization was performed.',
    year: 2018,
    journal: 'Pediatric Critical Care (fictional)',
    authors: ['Ogawa R'],
    volume: '2',
    issue: '4',
    pages: '210-218',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Extracorporeal Membrane Oxygenation', 'Child'],
  }),
  paper({
    pmid: '90000011',
    title: 'Case report: successful use of ECMO in a young adult with fulminant myocarditis',
    abstract:
      'We report a case of a young adult with fulminant myocarditis successfully treated with ECMO. The patient had no diagnosed pulmonary parenchymal disease.',
    year: 2017,
    journal: 'Case Reports in Critical Care (fictional)',
    authors: ['Yoshida K'],
    volume: '1',
    issue: '1',
    pages: '1-4',
    doi: null,
    mesh: ['Myocarditis', 'Extracorporeal Membrane Oxygenation'],
  }),
  paper({
    pmid: '90000012',
    title:
      'Long-term outcomes of adult ARDS survivors treated with prone positioning and lung-protective ventilation: a randomized trial',
    abstract:
      'Adult ARDS survivors were randomized to prone positioning combined with lung-protective ventilation versus standard ventilation, evaluating long-term outcomes. Neither arm received any form of extracorporeal circulatory support.',
    year: 2021,
    journal: 'J Crit Care Med (fictional)',
    authors: ['Kato S'],
    volume: '14',
    issue: '2',
    pages: '99-108',
    doi: null,
    mesh: ['Respiratory Distress Syndrome', 'Respiration, Artificial'],
  }),
];

/** PMID → 論文の索引。 */
export const DEMO_CORPUS_BY_PMID: ReadonlyMap<string, DemoPaper> = new Map(
  DEMO_CORPUS.map((p) => [p.pmid, p])
);

/**
 * NCBI `db=mesh` の esearch/esummary モック用: descriptor → 架空 UID / tree number。
 * 実在の NLM ツリー番号ではなく、階層図（Mermaid）を非空にするための架空値。
 */
export const DEMO_MESH_TREE: ReadonlyMap<string, { uid: string; treeNumbers: string[] }> = new Map([
  ['Respiratory Distress Syndrome', { uid: '9000101', treeNumbers: ['C08.618.248'] }],
  ['Extracorporeal Membrane Oxygenation', { uid: '9000102', treeNumbers: ['E04.100.400'] }],
  ['Respiratory Insufficiency', { uid: '9000103', treeNumbers: ['C08.618.500'] }],
]);
