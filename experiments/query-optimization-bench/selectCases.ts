import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditGold, FIXTURES, type GoldRecord, type ParsedReview } from './prepare';
import { seededShuffle } from './shuffle';

export interface SelectionGold extends GoldRecord { cochrane_id: string; needs_review: boolean }
export interface SelectionParsed extends ParsedReview {
  search_methods_text?: string;
  search_strategies?: { database: string; raw_text: string }[];
}
export interface SearchDate { pmcid: string; status: string; needs_review: boolean; medline_last_search_date: string }
export type Decisions = Record<string, { updateSearch: boolean; note: string }>;
export interface ScreeningRow {
  pmcid: string; cochraneId: string; title: string; searchDate: string | null;
  criteria: Record<string, { pass: boolean; evidence: unknown }>;
  updateSearchFlag: boolean; updateSearchEvidence: { source: string; excerpt: string }[];
  decision: Decisions[string] | null;
  status: 'eligible' | 'ineligible' | 'pending'; reasons: string[];
}
const excluded = ['PMC9009295', 'PMC9943918', 'PMC9936832', 'PMC10164701', 'PMC5865125', 'PMC11384553', 'PMC11110109'];

export function medlineMatchedBy(strategy: { database: string; raw_text: string }): 'databaseLabel' | 'coverage1946' | 'pubmedFieldTag' | null {
  if (/MEDLINE|PubMed/i.test(strategy.database)) return 'databaseLabel';
  if (/Embase|CENTRAL|Cochrane|CINAHL|PsycINFO|Web of Science|Scopus|ClinicalTrials|ICTRP/i.test(strategy.database)) return null;
  if (/\b1946\b/.test(strategy.database)) return 'coverage1946';
  if (/\[(?:Mesh|MeSH Terms|tiab|Title\/Abstract|pt|Publication Type)\]/i.test(strategy.raw_text)) return 'pubmedFieldTag';
  return null;
}

export function lastNumberedStep(raw: string): string | null {
  const ovid = [...raw.matchAll(/(?:^|\s)(\d+)\.\s|^\s*(\d+)\s+\S/gm)];
  if (ovid.length) return raw.slice(ovid[ovid.length - 1]!.index!).trim();
  // PubMed の参照番号も一致する。見出し直後と Boolean 演算子直後は本文の参照として同じステップに残す。
  const matches = [...raw.matchAll(/#(\d+)\s/g)];
  let last: RegExpMatchArray | undefined;
  for (const match of matches) {
    const body = last ? raw.slice(last.index! + last[0].length, match.index!) : null;
    if (body !== null && (!body.trim() || /\b(?:AND|OR|NOT)\s*$/i.test(body))) continue;
    last = match;
  }
  return last ? raw.slice(last.index!).trim() : null;
}

export function closesWithAnd(raw: string): { pass: boolean; lastStep: string | null } {
  const lastStep = lastNumberedStep(raw);
  return { lastStep, pass: lastStep !== null && (/^\d+\.\s+\d+(?:\s+and\s+\d+)+$/i.test(lastStep)
    || /^\d+\s+\d+(?:\s+and\s+\d+)+$/i.test(lastStep)
    || /^#\d+\s+#\d+(?:\s+and\s+#\d+)+$/i.test(lastStep)) };
}

export function updateEvidence(parsed: SelectionParsed): ScreeningRow['updateSearchEvidence'] {
  const evidence: ScreeningRow['updateSearchEvidence'] = [];
  const collect = (source: string, raw: string, pattern: RegExp, omitCoverage = false) => {
    for (const match of raw.matchAll(pattern)) {
      if (omitCoverage && /^1946\s*(?:to|-|–)/i.test(match[0])) continue;
      evidence.push({ source, excerpt: raw.slice(Math.max(0, match.index! - 80), match.index! + match[0].length + 80) });
    }
  };
  collect('search_methods_text', parsed.search_methods_text ?? '', /\bupdat(e|ed|ing)\b/gi);
  for (const strategy of parsed.search_strategies ?? []) {
    // medlineStrategyClosesWithAnd と同じ規則で MEDLINE の検索式を見分け、収録範囲だけのラベルでも日付制限を検出する。
    if (!medlineMatchedBy(strategy)) continue;
    collect(strategy.database, strategy.raw_text, /\b(19|20)\d{2}\s*(to|-|–)\s*(current|present|(19|20)\d{2})\b/gi, true);
    collect(strategy.database, strategy.raw_text, /limit .* to .*(yr|ed|dt)\s*=/gi);
  }
  return evidence;
}

export function screenReview(gold: SelectionGold, parsed: SelectionParsed | null, date: SearchDate | undefined, decisions: Decisions): ScreeningRow {
  const audited = parsed ? auditGold(gold, parsed) : null;
  const audit = audited?.audit;
  const studies = audited?.groups.reduce((sum, group) => sum + group.members.length, 0) ?? null;
  const strategies = (parsed?.search_strategies ?? []).flatMap((s) => {
    const matchedBy = medlineMatchedBy(s);
    return matchedBy ? [{ database: s.database, matchedBy, ...closesWithAnd(s.raw_text) }] : [];
  });
  const criterion = (pass: boolean, evidence: unknown) => ({ pass, evidence });
  const criteria = {
    excludedPrior: criterion(!excluded.includes(gold.pmcid), { pmcid: gold.pmcid, excluded: excluded.includes(gold.pmcid) }),
    parsedAvailable: criterion(parsed !== null, parsed !== null),
    studiesWithPmid: criterion(studies !== null && studies >= 15, studies),
    noIncludedExcludedOverlap: criterion(!!audit && audit.overlapPmids.length === 0, audit?.overlapPmids ?? null),
    noSharedPmid: criterion(!!audit && audit.sharedPmids.length === 0 && audit.unmappedPmids.length === 0,
      { sharedPmids: audit?.sharedPmids ?? null, unmappedPmids: audit?.unmappedPmids ?? null }),
    withoutPmid: criterion(!!audit && audit.withoutPmid.length <= 3, audit?.withoutPmid ?? null),
    medlineStrategyClosesWithAnd: criterion(strategies.some((s) => s.pass), strategies),
    goldNotNeedsReview: criterion(gold.needs_review === false, gold.needs_review),
    searchDateFound: criterion(date?.status === 'found' && date.needs_review === false && /^\d{4}-\d{2}-\d{2}$/.test(date.medline_last_search_date), date ?? null),
  };
  const updateSearchEvidence = parsed ? updateEvidence(parsed) : [];
  const updateSearchFlag = updateSearchEvidence.length > 0;
  const decision = decisions[gold.pmcid] ?? null;
  const reasons = Object.entries(criteria).filter(([, value]) => !value.pass).map(([key]) => key);
  if (updateSearchFlag && decision?.updateSearch === true) reasons.push('updateSearch');
  const pending = !reasons.length && updateSearchFlag && !decision;
  return { pmcid: gold.pmcid, cochraneId: gold.cochrane_id, title: parsed?.title ?? '', searchDate: date?.medline_last_search_date ?? null,
    criteria, updateSearchFlag, updateSearchEvidence, decision, status: reasons.length ? 'ineligible' : pending ? 'pending' : 'eligible',
    reasons: pending ? ['updateSearch 判断待ち'] : reasons };
}

export function pickCases(rows: ScreeningRow[], seed: number, count: number, screeningRaw: string) {
  if (rows.some((row) => row.status === 'pending')) throw new Error('判断待ちがあります。判断ファイルを記入し screen を再実行してください');
  const eligible = rows.filter((row) => row.status === 'eligible').sort((a, b) => a.pmcid < b.pmcid ? -1 : a.pmcid > b.pmcid ? 1 : 0);
  const selected = seededShuffle(eligible, seed).slice(0, count).map((row, index) => ({
    pmcid: row.pmcid, cochraneId: row.cochraneId, title: row.title, searchDate: row.searchDate,
    suggestedId: `c${index + 1}-${row.title.trim().split(/\s+/).slice(0, 3).map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean).join('-')}`.slice(0, 41).replace(/-+$/, ''),
  }));
  return { seed, count, eligible: eligible.map((row) => row.pmcid), selected,
    screeningSha256: createHash('sha256').update(screeningRaw).digest('hex') };
}

const jsonLines = <T>(path: string): T[] => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
export function main(args: string[], benchDir = process.env.COCHRANE_BENCH_DIR ?? 'C:\\Users\\youki\\codes\\Cochrane-bench', output = join(FIXTURES, '_selection')): void {
  const [stage, ...rest] = args;
  if (stage === 'screen') {
    if (rest.length) throw new Error('screen に追加引数はありません');
    const decisionsPath = join(output, 'update-search-decisions.json');
    const decisions: Decisions = existsSync(decisionsPath) ? JSON.parse(readFileSync(decisionsPath, 'utf8')) : {};
    for (const decision of Object.values(decisions)) {
      if (typeof decision.updateSearch !== 'boolean' || typeof decision.note !== 'string') throw new Error('判断ファイルの形式が不正です');
    }
    const dates = jsonLines<SearchDate>(join(benchDir, 'data/audit/medline_search_dates/session_2026-09-14/final_cc-by.jsonl'));
    const rows = jsonLines<SelectionGold>(join(benchDir, 'data/processed/cc-by/gold/task2_search_screen.jsonl')).map((gold) => {
      const path = join(benchDir, 'data/interim/cc-by/parsed', `${gold.pmcid}.json`);
      return screenReview(gold, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SelectionParsed : null,
        dates.find((date) => date.pmcid === gold.pmcid), decisions);
    });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'screening.json'), JSON.stringify(rows, null, 2) + '\n');
    const cell = (value: unknown) => JSON.stringify(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    writeFileSync(join(output, 'screening.md'), '# 確認用ケースの選定\n\n| PMCID | タイトル | 状態 | 全基準と根拠 | 更新検索の根拠・判断 | 理由 |\n|---|---|---|---|---|---|\n'
      + rows.map((r) => `| ${r.pmcid} | ${cell(r.title)} | ${r.status} | ${cell(r.criteria)} | ${cell([r.updateSearchFlag, r.updateSearchEvidence, r.decision])} | ${cell(r.reasons)} |`).join('\n') + '\n');
    process.stdout.write(`全 ${rows.length} 件 / 適格 ${rows.filter((r) => r.status === 'eligible').length} 件 / 判断待ち: ${rows.filter((r) => r.status === 'pending').map((r) => r.pmcid).join(', ') || '0 件'}\n`);
  } else if (stage === 'pick') {
    const options = new Map<string, number>();
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]!; const raw = rest[i + 1];
      if (!['--seed', '--count'].includes(key) || options.has(key) || raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('pick は --seed <整数> --count <正整数> を指定してください');
      options.set(key, Number(raw));
    }
    const seed = options.get('--seed'); const count = options.get('--count');
    if (seed === undefined || count === undefined || count < 1) throw new Error('--seed と --count が必要です');
    const raw = readFileSync(join(output, 'screening.json'), 'utf8');
    const result = pickCases(JSON.parse(raw) as ScreeningRow[], seed, count, raw);
    writeFileSync(join(output, 'confirmation-cases.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(`選定 ${result.selected.length} 件${result.eligible.length < count ? '（適格が要求数未満のため全件）' : ''}\n`);
  } else throw new Error('screen または pick を指定してください');
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
