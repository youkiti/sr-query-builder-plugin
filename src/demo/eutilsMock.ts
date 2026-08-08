/**
 * NCBI E-utilities（`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/*`）のモック。
 *
 * esearch のヒット数・PMID 一覧、efetch の書誌情報はすべて `corpus.ts` +
 * `queryEngine.ts` から導出する（ハードコードした件数を別に持たない。
 * video/REQUIREMENTS.md §6-2）。db=mesh 系（esearch/esummary）だけは
 * MeSH シソーラスという別のコーパス（`DEMO_MESH_TREE`）を参照する。
 */

import { DEMO_CORPUS, DEMO_CORPUS_BY_PMID, DEMO_MESH_TREE, type DemoPaper } from './corpus';
import { jsonResponse, textResponse } from './fakeResponse';
import { evaluateQuery } from './queryEngine';

/** `db=mesh` の esearch: `"<descriptor>"[mh]` から UID を 1 件に解決する。 */
function handleMeshEsearch(term: string): Response {
  // resolveMeshUid は `${descriptor}[mh]` の形で term を組み立てる（mesh.ts）。
  const descriptor = term.replace(/\[mh\]\s*$/i, '').trim();
  const entry = Array.from(DEMO_MESH_TREE.entries()).find(
    ([name]) => name.toLowerCase() === descriptor.toLowerCase()
  );
  const idlist = entry ? [entry[1].uid] : [];
  return jsonResponse({ esearchresult: { count: String(idlist.length), idlist } });
}

function handlePubmedEsearch(term: string, retmax: number, retstart: number): Response {
  const matches = evaluateQuery(term, DEMO_CORPUS);
  const idlist =
    retmax <= 0 ? [] : matches.slice(retstart, retstart + retmax).map((p) => p.pmid);
  return jsonResponse({ esearchresult: { count: String(matches.length), idlist } });
}

function handleEsearch(url: URL): Response {
  const db = url.searchParams.get('db') ?? 'pubmed';
  const term = url.searchParams.get('term') ?? '';
  const retmax = Number.parseInt(url.searchParams.get('retmax') ?? '20', 10);
  const retstart = Number.parseInt(url.searchParams.get('retstart') ?? '0', 10);
  if (db === 'mesh') {
    return handleMeshEsearch(term);
  }
  if (db === 'pubmed') {
    return handlePubmedEsearch(term, Number.isFinite(retmax) ? retmax : 20, Number.isFinite(retstart) ? retstart : 0);
  }
  throw new Error(`[demo] eutilsMock: 未対応の esearch db です: ${db}`);
}

function handleEsummary(url: URL): Response {
  const db = url.searchParams.get('db') ?? '';
  if (db !== 'mesh') {
    throw new Error(`[demo] eutilsMock: 未対応の esummary db です: ${db}`);
  }
  const ids = (url.searchParams.get('id') ?? '').split(',').filter((v) => v !== '');
  const byUid = new Map(Array.from(DEMO_MESH_TREE.values()).map((v) => [v.uid, v]));
  const result: Record<string, unknown> = { uids: ids };
  for (const uid of ids) {
    const entry = byUid.get(uid);
    result[uid] = { ds_idxlinks: (entry?.treeNumbers ?? []).map((treenum) => ({ treenum })) };
  }
  return jsonResponse({ result });
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `"LastName Initials"` 形式の著者文字列を分解する（本コーパスの authors はこの形式で統一）。 */
function splitAuthor(name: string): { lastName: string; initials: string } {
  const idx = name.lastIndexOf(' ');
  if (idx < 0) {
    return { lastName: name, initials: '' };
  }
  return { lastName: name.slice(0, idx), initials: name.slice(idx + 1) };
}

function renderMeshHeadingList(paper: DemoPaper): string {
  if (paper.meshHeadings.length === 0) {
    return '';
  }
  const items = paper.meshHeadings
    .map(
      (descriptor) =>
        `<MeshHeading><DescriptorName MajorTopicYN="Y">${escapeXml(descriptor)}</DescriptorName></MeshHeading>`
    )
    .join('');
  return `<MeshHeadingList>${items}</MeshHeadingList>`;
}

function renderAuthorList(paper: DemoPaper): string {
  if (paper.authors.length === 0) {
    return '';
  }
  const items = paper.authors
    .map((raw) => {
      const { lastName, initials } = splitAuthor(raw);
      return `<Author><LastName>${escapeXml(lastName)}</LastName><Initials>${escapeXml(
        initials
      )}</Initials></Author>`;
    })
    .join('');
  return `<AuthorList>${items}</AuthorList>`;
}

function renderArticle(paper: DemoPaper): string {
  return `
<PubmedArticle>
  <MedlineCitation>
    <PMID>${escapeXml(paper.pmid)}</PMID>
    <Article>
      <Journal>
        <JournalIssue>
          <Volume>${escapeXml(paper.volume)}</Volume>
          <Issue>${escapeXml(paper.issue)}</Issue>
          <PubDate><Year>${paper.year}</Year></PubDate>
        </JournalIssue>
        <Title>${escapeXml(paper.journal)}</Title>
      </Journal>
      <ArticleTitle>${escapeXml(paper.title)}</ArticleTitle>
      <Pagination><MedlinePgn>${escapeXml(paper.pages)}</MedlinePgn></Pagination>
      <Abstract><AbstractText>${escapeXml(paper.abstract)}</AbstractText></Abstract>
      ${renderAuthorList(paper)}
    </Article>
    ${renderMeshHeadingList(paper)}
  </MedlineCitation>
</PubmedArticle>`.trim();
}

function handleEfetch(url: URL): Response {
  const db = url.searchParams.get('db') ?? 'pubmed';
  if (db !== 'pubmed') {
    throw new Error(`[demo] eutilsMock: 未対応の efetch db です: ${db}`);
  }
  const ids = (url.searchParams.get('id') ?? '').split(',').filter((v) => v !== '');
  const articles = ids
    .map((pmid) => DEMO_CORPUS_BY_PMID.get(pmid))
    .filter((p): p is DemoPaper => p !== undefined)
    .map(renderArticle)
    .join('\n');
  const xml = `<?xml version="1.0"?>\n<PubmedArticleSet>\n${articles}\n</PubmedArticleSet>`;
  return textResponse(xml);
}

/**
 * `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/*` 宛のリクエストを処理する。
 * 対応外のエンドポイントは明示的にエラーを投げる（気づかないまま実ネットワークに
 * 出るのを防ぐ設計方針。video/REQUIREMENTS.md ブリーフ参照）。
 */
export function handleEutilsRequest(rawUrl: string): Response {
  const url = new URL(rawUrl);
  if (url.pathname.endsWith('/esearch.fcgi')) {
    return handleEsearch(url);
  }
  if (url.pathname.endsWith('/efetch.fcgi')) {
    return handleEfetch(url);
  }
  if (url.pathname.endsWith('/esummary.fcgi')) {
    return handleEsummary(url);
  }
  throw new Error(`[demo] eutilsMock: 未対応の E-utilities エンドポイントです: ${rawUrl}`);
}
