import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES } from './prepare';
import { CASES } from './types';
import { parseOvid, transpile, type PubmedLine, type ManualOverride } from './ovidToPubmed';

/** Ignore casing, redundant parentheses and order within associative AND/OR groups. */
export function canonicalQuery(query: string): string {
  if (!query.trim()) return '';
  const tokens = query.match(/"[^"]*"\[[^\]]+\]|[^\s()]+\[[^\]]+\]|\(|\)|\b(?:AND|OR|NOT)\b/gi) ?? [];
  type Node = { op: string; children: Node[] } | { term: string };
  let index = 0;
  const atom = (): Node => {
    const token = tokens[index++];
    if (!token) return { term: '' };
    if (token === '(') {
      const value = expression(0);
      if (tokens[index++] !== ')') throw new Error('Unbalanced PubMed query');
      return value;
    }
    return { term: token.replace(/"/g, '').toLowerCase() };
  };
  const precedence: Record<string, number> = { OR: 1, AND: 2, NOT: 3 };
  const expression = (minimum: number): Node => {
    let left = atom();
    while (index < tokens.length) {
      const op = tokens[index]!.toUpperCase();
      const priority = precedence[op] ?? -1;
      if (priority < minimum) break;
      index++;
      const right = expression(priority + 1);
      const children = [left, right].flatMap((node) => op !== 'NOT' && 'op' in node && node.op === op ? node.children : [node]);
      left = { op, children };
    }
    return left;
  };
  const serialize = (node: Node): string => {
    if ('term' in node) return node.term;
    const children = node.children.map(serialize);
    return `${node.op}(${(node.op === 'NOT' ? children : [...new Set(children)].sort()).join(',')})`;
  };
  const result = expression(0);
  if (index !== tokens.length) throw new Error('Unconsumed PubMed query');
  return serialize(result);
}

export function compareHuman(markdown: string, lines: readonly PubmedLine[]) {
  const block = markdown.split('```')[1] ?? '';
  const rows = [...block.replace(/※[^\n]*/g, '').matchAll(/^\s*(\d+)\s+([^]*?)(?=^\s*\d+\s+|^---|$(?![^]))/gm)];
  const expected = new Map(rows.map((row) => [Number(row[1]), row[2]!.trim().replace(/\s+/g, ' ')]));
  if (expected.size !== lines.length) throw new Error('Human reference line count mismatch');
  const expanded = new Map<number, string>();
  const expand = (n: number): string => {
    if (expanded.has(n)) return expanded.get(n)!;
    const value = expected.get(n);
    if (!value) throw new Error(`Missing human line ${n}`);
    const query = value.replace(/#(\d+) OR … OR #(\d+)/g, (_, from: string, to: string) =>
      Array.from({ length: Number(to) - Number(from) + 1 }, (__, i) => `#${Number(from) + i}`).join(' OR '))
      .replace(/#(\d+)/g, (_, ref: string) => `(${expand(Number(ref))})`);
    expanded.set(n, query);
    return query;
  };
  return lines.filter((line) => canonicalQuery(line.query) !== canonicalQuery(expand(line.n)))
    .map((line) => ({ n: line.n, expected: expected.get(line.n)!, actual: line.query,
      cause: /#\d/.test(expected.get(line.n)!) ? '参照先の差が伝播' :
        line.approximations.some((a) => a.kind === 'unsupported') ? '未対応のワイルドカードまたは句内語幹を省略・要人手判断' :
          '規則による機械変換と、人手での語形・語幹・MeSH選択が異なる' }));
}

export function generateB1(fixtureDir = FIXTURES, sourceDir = join(__dirname, 'b1')): boolean {
  let complete = true;
  CASES.filter((definition) => definition.role === 'development').forEach((definition, i) => {
    const dir = join(fixtureDir, definition.id);
    const jsonPath = join(dir, 'b1.json');
    // Keep the query and its derivation together when a baseline has been frozen.
    if (existsSync(jsonPath)) { process.stdout.write(`${definition.id}: frozen; skipped\n`); return; }
    const allowlist = JSON.parse(readFileSync(join(sourceDir, 'mesh-allowlist.json'), 'utf8')) as Record<string, string[]>;
    const knownWords = JSON.parse(readFileSync(join(sourceDir, 'known-words.json'), 'utf8')) as string[];
    const overridePath = join(sourceDir, 'overrides', `${definition.id}.json`);
    const overrides = existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, 'utf8')) as Record<string, ManualOverride> : {};
    const lines = transpile(parseOvid(readFileSync(join(sourceDir, `r${i + 1}_ovid.txt`), 'utf8')),
      { meshHeadings: allowlist[definition.id] ?? [], knownWords, overrides });
    const query = lines[lines.length - 1]?.query;
    const humanPath = join(sourceDir, `r${i + 1}.md`);
    const differences = existsSync(humanPath) ? compareHuman(readFileSync(humanPath, 'utf8'), lines) : [];
    const report = [`# ${definition.id}: Ovid → PubMed`,
      '明示ブリーフを優先: 切り捨てを伴う近接は AND、副標目は exp がない限り noexp。未知の ? は省略して要人手判断。',
      '句内の切り捨ては known-words.json の完結した語に限り単複化し、それ以外は人手判断まで出力しない。',
      '`.mp.` は tiab を出し、大小文字を除いて許可リストに完全一致し、切り捨てを含まない語だけ Mesh を追加する。',
      ...lines.map((line) => `## ${line.n}\n\n元: ${line.source}\n\n\`\`\`text\n${line.query}\n\`\`\`\n\n${line.manualOverride ? `人手上書き: ${line.manualOverride.note}` : line.approximations.map((a) => `- ${a.kind}: ${a.detail}`).join('\n') || '近似記録なし'}`),
      '## Unsupported（人手判断が必要）',
      ...lines.flatMap((line) => line.approximations.filter((a) => a.kind === 'unsupported').map((a) => `- ${line.n}: ${a.detail}`)),
      '## 人手期待値との差分',
      '比較では大小文字・冗長括弧・AND/OR 内の順序と重複を正規化し、履歴参照を完全展開する。',
      ...differences.map((d) => `### ${d.n}\n\n期待: ${d.expected}\n\n実際:\n\n\`\`\`text\n${d.actual}\n\`\`\`\n\n原因の推測: ${d.cause}`),
    ].join('\n\n') + '\n';
    const unsupported = lines.filter((line) => line.approximations.some((a) => a.kind === 'unsupported'));
    if (unsupported.length) {
      complete = false;
      writeFileSync(join(sourceDir, `review-${definition.id}.md`), [
        `# ${definition.id}: 人手判断が必要な行（${unsupported.length} 件、参照先からの伝播を含む）`,
        ...unsupported.map((line) => `## 行 ${line.n}\n\n元の式: ${line.source}\n\n${line.approximations.filter((a) => a.kind === 'unsupported').map((a) => `- 理由: ${a.detail}`).join('\n')}`),
        '## 変換記録（未解決のため計測禁止）', report,
      ].join('\n\n'));
      process.stdout.write(`${definition.id}: 人手判断が必要な行=${unsupported.length}; b1.json は未出力; differences=${differences.map((d) => d.n).join(',')}\n`);
      return;
    }
    if (!query) throw new Error(`${definition.id}: empty final query`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b1.md'), report, { flag: 'wx' });
    writeFileSync(jsonPath, JSON.stringify({ query }, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(`${definition.id}: lines=${lines.length}, queryChars=${query.length}, differences=${differences.map((d) => d.n).join(',')}\n`);
  });
  return complete;
}

if (require.main === module && !generateB1()) process.exitCode = 1;
