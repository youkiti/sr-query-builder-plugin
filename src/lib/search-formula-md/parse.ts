import {
  PUBMED_HEADING_PATTERN,
  type FormulaBlock,
  type PubmedFormula,
} from './types';

/** パースに失敗した理由を表すエラー */
export class FormulaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaParseError';
  }
}

const FENCE_OPEN = /^```[^\n]*\n/m;
const FENCE_CLOSE = /\n```\s*$/m;
const LINE_PATTERN = /^#([A-Za-z0-9]+)\s+(.+?)\s*$/;
const REFERENCE_PATTERN = /#([A-Za-z0-9]+)/g;

/**
 * search_formula.md 互換のマークダウンから PubMed セクションを抽出してパースする。
 *
 * @throws {FormulaParseError} セクションやコードブロックが見つからない場合
 */
export function parsePubmedFormulaMd(md: string): PubmedFormula {
  const headingMatch = md.match(PUBMED_HEADING_PATTERN);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new FormulaParseError(
      'PubMed セクション（`## PubMed/MEDLINE` または `## PubMed`）が見つかりません'
    );
  }
  const afterHeading = md.slice(headingMatch.index + headingMatch[0].length);
  // 次の `## ` 見出しまでをセクションとする
  const nextHeadingIdx = afterHeading.search(/^##\s+/m);
  const section = nextHeadingIdx >= 0 ? afterHeading.slice(0, nextHeadingIdx) : afterHeading;

  const openMatch = section.match(FENCE_OPEN);
  if (!openMatch || openMatch.index === undefined) {
    throw new FormulaParseError('PubMed セクション内にフェンスドコードブロックが見つかりません');
  }
  const bodyStart = openMatch.index + openMatch[0].length;
  const afterOpen = section.slice(bodyStart);
  const closeMatch = afterOpen.match(FENCE_CLOSE);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new FormulaParseError('コードブロックの閉じフェンス（```）が見つかりません');
  }
  const body = afterOpen.slice(0, closeMatch.index);
  return parseBody(body);
}

function parseBody(body: string): PubmedFormula {
  const blocks: FormulaBlock[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    const match = line.match(LINE_PATTERN);
    if (!match) {
      throw new FormulaParseError(`ブロック形式に一致しない行があります: "${line}"`);
    }
    // LINE_PATTERN が 2 つのキャプチャを保証する
    const id = match[1] as string;
    const expression = match[2] as string;
    if (blocks.some((b) => b.id === id)) {
      throw new FormulaParseError(`ブロック ID が重複しています: #${id}`);
    }
    blocks.push({ id, expression, isCombination: false });
  }

  if (blocks.length === 0) {
    return { blocks: [], combinationExpression: null };
  }

  const knownIds = new Set(blocks.map((b) => b.id));
  for (const block of blocks) {
    block.isCombination = containsOtherReference(block.expression, block.id, knownIds);
  }

  const combinationExpression = findCombinationExpression(blocks);
  return { blocks, combinationExpression };
}

function containsOtherReference(
  expression: string,
  selfId: string,
  knownIds: ReadonlySet<string>
): boolean {
  for (const match of expression.matchAll(REFERENCE_PATTERN)) {
    // REFERENCE_PATTERN が 1 つのキャプチャを保証する
    const ref = match[1] as string;
    if (ref !== selfId && knownIds.has(ref)) {
      return true;
    }
  }
  return false;
}

function findCombinationExpression(blocks: FormulaBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block && block.isCombination) {
      return block.expression;
    }
  }
  return null;
}
