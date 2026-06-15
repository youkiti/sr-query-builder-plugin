import type { EutilsDeps } from './eutils';
import { EutilsError } from './eutils';
import { retryWithBackoff } from './rateLimit';

/**
 * NLM MeSH RDF（SPARQL）を叩いて MeSH ツリーを「名前付き」で辿るための薄いラッパ。
 *
 * eutils（`db=mesh`）は descriptor → tree number の解決はできるが、
 * - tree number → descriptor 名の逆引き（祖先ノードの名前表示）
 * - ある tree number の「子ノード（1 段下）」の列挙
 * ができない。これらは公式リンクトデータ（<https://id.nlm.nih.gov/mesh/sparql>）が必要。
 *
 * CORS: 当エンドポイントは `Access-Control-Allow-Origin: *` を返すため、拡張機能の
 * コンテキストから直接 fetch できる（host_permissions に `https://id.nlm.nih.gov/*` を要追加）。
 *
 * `EutilsDeps` を流用するが、SPARQL には tool/api_key/email は不要なので
 * `fetch` / `sleep` / `maxRetries` のみを使う。
 */

const SPARQL_URL = 'https://id.nlm.nih.gov/mesh/sparql';

const PREFIXES = [
  'PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'PREFIX mesh: <http://id.nlm.nih.gov/mesh/>',
].join('\n');

/** MeSH tree number の形（例: `M01.526.485.810.910`）。先頭 1 文字 + 数字・ドット。 */
const TREE_NUMBER_RE = /^[A-Z][0-9]+(\.[0-9]+)*$/;

/** ツリー上の 1 ノード（tree number + descriptor UI + 表示ラベル）。 */
export interface MeshTreeNode {
  /** tree number（例: `M01.526.485.810.910.750`） */
  treeNumber: string;
  /** descriptor UI（例: `D000069471`） */
  descriptorUi: string;
  /** descriptor 名（PubMed の `"<label>"[Mesh]` に使える表示名。例: `Neurosurgeons`） */
  label: string;
}

/** SPARQL JSON 結果のうち、本モジュールが参照する最小形。 */
export interface SparqlJson {
  results?: {
    bindings?: Array<Record<string, { value?: string } | undefined>>;
  };
}

/** IRI（`http://id.nlm.nih.gov/mesh/D000069471`）の末尾セグメントを取り出す。 */
function localName(iri: string): string {
  const slash = iri.lastIndexOf('/');
  return slash >= 0 ? iri.slice(slash + 1) : iri;
}

/** tree number として妥当な文字列だけ通す（SPARQL への素朴な注入を防ぐ）。 */
function isValidTreeNumber(treeNumber: string): boolean {
  return TREE_NUMBER_RE.test(treeNumber);
}

/** SPARQL を GET で実行し、JSON 結果を返す。 */
async function runSparql(query: string, deps: EutilsDeps): Promise<SparqlJson> {
  const params = new URLSearchParams({ query, format: 'JSON' });
  const url = `${SPARQL_URL}?${params.toString()}`;
  return retryWithBackoff(
    async () => {
      const res = await deps.fetch(url);
      if (!res.ok) {
        throw new EutilsError(`mesh sparql failed: HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as SparqlJson;
    },
    { sleep: deps.sleep, maxRetries: deps.maxRetries ?? 5 }
  );
}

/**
 * 指定 tree number の「子ノード（immediate children）」を名前付きで返す。
 * label（descriptor 名）の昇順で安定ソートする。tree number が不正なら空配列。
 */
export async function fetchMeshChildren(
  treeNumber: string,
  deps: EutilsDeps
): Promise<MeshTreeNode[]> {
  if (!isValidTreeNumber(treeNumber)) {
    return [];
  }
  const query = `${PREFIXES}
SELECT ?childTN ?desc ?label WHERE {
  ?childTN meshv:parentTreeNumber mesh:${treeNumber} .
  ?desc meshv:treeNumber ?childTN .
  ?desc rdfs:label ?label .
}`;
  const json = await runSparql(query, deps);
  return parseTreeNodes(json).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 複数 tree number → ノード（descriptor UI + label）のバッチ逆引き。
 * 祖先ノードの名前表示に使う。不正な tree number は除外し、全滅なら fetch しない。
 */
export async function fetchMeshLabels(
  treeNumbers: readonly string[],
  deps: EutilsDeps
): Promise<Map<string, MeshTreeNode>> {
  const result = new Map<string, MeshTreeNode>();
  const valid = Array.from(new Set(treeNumbers.map((t) => t.trim()))).filter(isValidTreeNumber);
  if (valid.length === 0) {
    return result;
  }
  const values = valid.map((t) => `mesh:${t}`).join(' ');
  const query = `${PREFIXES}
SELECT ?tn ?desc ?label WHERE {
  VALUES ?tn { ${values} }
  ?desc meshv:treeNumber ?tn .
  ?desc rdfs:label ?label .
}`;
  const json = await runSparql(query, deps);
  for (const node of parseTreeNodes(json, 'tn')) {
    // 同一 tree number は 1 descriptor。最初の 1 件を採用する。
    if (!result.has(node.treeNumber)) {
      result.set(node.treeNumber, node);
    }
  }
  return result;
}

/**
 * SPARQL bindings を MeshTreeNode[] にする。
 * tree number 変数名は children クエリでは `childTN`、labels クエリでは `tn`。
 */
function parseTreeNodes(json: SparqlJson, tnVar: 'childTN' | 'tn' = 'childTN'): MeshTreeNode[] {
  const out: MeshTreeNode[] = [];
  for (const b of json.results?.bindings ?? []) {
    const tnIri = b[tnVar]?.value;
    const descIri = b.desc?.value;
    const label = b.label?.value;
    if (!tnIri || !descIri || !label) {
      continue;
    }
    out.push({
      treeNumber: localName(tnIri),
      descriptorUi: localName(descIri),
      label,
    });
  }
  return out;
}
