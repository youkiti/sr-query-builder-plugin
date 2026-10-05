import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPLITS, type Split } from './split';

export interface Leak { term: string; kind: 'word' | 'identifier'; reviews: Record<Split, number> }
interface LeakReview { split: Split; title: string; protocol: string }
const identifier = (term: string): boolean => /^(?:\d{7,8}|pmc\d+|cd\d{6})$/i.test(term);

export function candidateTerms(text: string): Set<string> {
  // 数字・ハイフンを含む語を分割せず、英字の合計が四文字以上のものを残す。
  return new Set((text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .filter((term) => identifier(term) || (term.match(/[a-z]/g) ?? []).length >= 4));
}

export function findLeaks(procedure: string, reviews: LeakReview[], allowlist: Set<string>): Leak[] {
  const rows = reviews.map((review) => ({ split: review.split, title: candidateTerms(review.title), protocol: candidateTerms(review.protocol) }));
  const allowed = new Set([...allowlist].map((term) => term.toLowerCase()));
  const leaks: Leak[] = [];
  for (const term of [...candidateTerms(procedure)].sort()) {
    const counts: Record<Split, number> = { development: 0, validation: 0, test: 0 };
    for (const row of rows) if (row.title.has(term)) counts[row.split]++;
    const isIdentifier = identifier(term);
    if (isIdentifier || (SPLITS.some((split) => counts[split] > 0) && !allowed.has(term)
      && rows.filter((row) => row.protocol.has(term)).length <= reviews.length * 0.05)) {
      leaks.push({ term, kind: isIdentifier ? 'identifier' : 'word', reviews: counts });
    }
  }
  return leaks;
}

export function procedureBody(procedure: string): string {
  const lines = procedure.split(/\r?\n/);
  const separator = lines.indexOf('---');
  if (separator < 0) throw new Error('手順書にコメントと本文の区切りがありません');
  return lines.slice(separator + 1).join('\n');
}

interface LeakRuntime { casesDir: string; harnessDir: string; stdout: (text: string) => void }
export function main(args: string[], runtime: LeakRuntime = { casesDir: resolve(__dirname, '../cases'),
  harnessDir: resolve(__dirname, '../harness'), stdout: (text) => process.stdout.write(text) }): number {
  if (args.length !== 2 || args[0] !== '--version' || !/^[A-Za-z0-9_-]+$/.test(args[1]!)) throw new Error('--version に有効な版を指定してください');
  const read = (path: string, label: string): string => {
    try { return readFileSync(path, 'utf8'); }
    catch { throw new Error(`${label}を読めません`); }
  };
  const parseIndex = (line: string): { pmcid: string; split: Split; title: string } => {
    let row: { pmcid: string; split: Split; title: string };
    try { row = JSON.parse(line) as typeof row; }
    catch { throw new Error('レビュー索引の形式が不正です'); }
    if (!row || !/^PMC\d+$/.test(row.pmcid) || !SPLITS.includes(row.split) || typeof row.title !== 'string') throw new Error('レビュー索引の項目が不正です');
    return row;
  };
  const reviews = read(join(runtime.casesDir, 'index.jsonl'), 'レビュー索引').split(/\r?\n/).filter((line) => line.trim()).map(parseIndex)
    .map((row) => ({ split: row.split, title: row.title, protocol: read(join(runtime.casesDir, row.pmcid, 'protocol.md'), 'プロトコル') }));
  const procedure = procedureBody(read(join(runtime.harnessDir, args[1]!, 'procedure.md'), '手順書'));
  const allowlist = new Set(read(join(runtime.harnessDir, 'leak-allowlist.txt'), '許可語一覧').split(/\r?\n/)
    .map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith('#')));
  const leaks = findLeaks(procedure, reviews, allowlist);
  runtime.stdout(`検査した候補語: ${candidateTerms(procedure).size} 件、固有の語: ${leaks.length} 件\n`);
  for (const leak of leaks) runtime.stdout(`${leak.term} (${leak.kind}): ${SPLITS.map((split) => `${split}=${leak.reviews[split]}`).join(', ')}\n`);
  return leaks.length ? 1 : 0;
}
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
}
