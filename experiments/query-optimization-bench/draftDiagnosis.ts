import { expandFormula } from '../../src/features/validation/expandFormula';
import type { PubmedFormula } from '../../src/lib/search-formula-md';
import { LlmProviderError } from '../../src/lib/llm';
import { classifyApiError } from '../../src/lib/api-error';
import { esearch, EutilsError, resolveRateLimiter, shouldRetryEutils, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { retryWithBackoff } from '../../src/lib/ncbi/rateLimit';

export type Outcome = 'generation_transient' | 'generation_failed' | 'network_error' | 'syntax_error' | 'other_error' | 'zero' | 'ok';
export type DiagnosticStatus = 'ok' | 'zero' | 'syntax_error' | 'network_error' | 'other_error';
export interface Diagnostic {
  target: 'block' | 'formula'; id: string; expression: string; status: DiagnosticStatus;
  count: number | null; error: string | null; phrasesNotFound: string[]; fieldsNotFound: string[];
}
export interface MeshLookup {
  phrase: string; term: string | null;
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'lookup_failed' | 'not_mesh';
  error: string | null;
}

export class FetchFailure extends Error {}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function generationOutcome(error: unknown): Outcome {
  const kind = classifyApiError(error);
  return error instanceof FetchFailure || (error instanceof LlmProviderError
    && (kind === 'rate_limit' || kind === 'temporary' || (error.status !== null && error.status >= 500)))
    ? 'generation_transient' : 'generation_failed';
}

export function parseSyntaxMessage(message: string): Pick<Diagnostic, 'phrasesNotFound' | 'fieldsNotFound'> {
  const phrasePrefix = '構文エラー: phrase not found ';
  const fieldPrefix = '構文エラー: 不明なフィールドタグ ';
  return {
    phrasesNotFound: message.startsWith(phrasePrefix) ? message.slice(phrasePrefix.length + 1, -1).split('", "') : [],
    fieldsNotFound: message.startsWith(fieldPrefix) ? message.slice(fieldPrefix.length + 1, -1).split('], [') : [],
  };
}

const meshTag = /\[(?:mesh|mesh terms|mh|majr|mesh major topic)(?::noexp)?\]/i;
function normalizeTerm(value: string): string {
  return value.replace(/\[[^\]]+\]/g, '').replace(/"/g, '').trim().split('/')[0]!.trim();
}

export function meshTerm(phrase: string, expression: string): string | null {
  const term = normalizeTerm(phrase);
  // タグ無しの返答も、対象式のタグ付き語との照合で判定する。
  const atoms = expression.match(/(?:"[^"]+"|[^()[\]"]+)\[[^\]]+\]/g) ?? [];
  for (const atom of atoms) {
    if (!meshTag.test(atom)) continue;
    const candidate = normalizeTerm(atom.startsWith('"') ? atom : atom.replace(/^.*\b(?:AND|OR|NOT)\s+/, ''));
    if (candidate.toLowerCase() === term.toLowerCase()) return term;
  }
  return null;
}

export async function lookupMesh(phrase: string, expression: string, deps: EutilsDeps): Promise<MeshLookup> {
  const term = meshTerm(phrase, expression);
  if (term === null) return { phrase, term, status: 'not_mesh', error: null };
  try {
    const count = await retryWithBackoff(async () => {
      await resolveRateLimiter(deps).acquire();
      const params = new URLSearchParams({ db: 'mesh', term: `"${term}"[mh]`, retmax: '2', retmode: 'json', tool: deps.tool ?? 'sr-query-builder-plugin' });
      if (deps.apiKey) params.set('api_key', deps.apiKey);
      const response = await deps.fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`);
      if (!response.ok) throw new EutilsError(`MeSH 照会エラー: HTTP ${response.status}`, response.status);
      const body = await response.json() as { error?: string; esearchresult?: { count?: string; ERROR?: string; errorlist?: { fieldsnotfound?: unknown; phrasesnotfound?: unknown } } };
      if (body.error) throw new EutilsError(`MeSH 照会エラー: ${body.error}`, response.status);
      const result = body.esearchresult;
      const fields = result?.errorlist?.fieldsnotfound;
      const phrases = result?.errorlist?.phrasesnotfound;
      if (result?.ERROR !== undefined || (Array.isArray(fields) && fields.length > 0)) {
        throw new EutilsError('MeSH 照会の応答が不正です', response.status, true);
      }
      if (Array.isArray(phrases) && phrases.length > 0) return 0;
      if (!/^\d+$/.test(result?.count ?? '') || !Number.isSafeInteger(Number(result?.count))) {
        throw new EutilsError('MeSH 照会の応答が不正です', response.status, true);
      }
      return Number(result!.count);
    }, { sleep: deps.sleep, maxRetries: deps.maxRetries, shouldRetry: shouldRetryEutils });
    return { phrase, term, status: count === 0 ? 'unresolved' : count === 1 ? 'resolved' : 'ambiguous', error: null };
  } catch (error) { return { phrase, term, status: 'lookup_failed', error: errorText(error) }; }
}

export async function diagnoseFormula(formula: PubmedFormula, deps: EutilsDeps): Promise<{ diagnostics: Diagnostic[]; meshLookups: MeshLookup[] }> {
  const diagnostics: Diagnostic[] = [];
  const meshLookups: MeshLookup[] = [];
  const network: typeof fetch = async (input, init) => {
    try { return await deps.fetch(input, init); }
    catch (error) {
      if (error instanceof EutilsError) throw error;
      throw new FetchFailure(errorText(error));
    }
  };
  const targets = formula.blocks.filter((block) => !block.isCombination)
    .map((block) => ({ target: 'block' as const, id: block.id, expression: () => block.expression }));
  const checks = [...targets, { target: 'formula' as const, id: 'whole', expression: () => expandFormula(formula) }];
  for (const check of checks) {
    const diagnostic: Diagnostic = { target: check.target, id: check.id, expression: '', status: 'other_error', count: null, error: null, phrasesNotFound: [], fieldsNotFound: [] };
    try {
      diagnostic.expression = check.expression();
      const result = await esearch(diagnostic.expression, { ...deps, fetch: network, strictCounts: true }, { retmax: 0 });
      diagnostic.count = result.count;
      diagnostic.status = result.count === 0 ? 'zero' : 'ok';
    } catch (error) {
      diagnostic.error = errorText(error);
      diagnostic.status = error instanceof EutilsError ? (!error.permanent ? 'network_error'
        : error.message.startsWith('構文エラー:') ? 'syntax_error' : 'other_error')
        : error instanceof FetchFailure ? 'network_error' : 'other_error';
      if (diagnostic.status === 'syntax_error') Object.assign(diagnostic, parseSyntaxMessage(diagnostic.error));
    }
    diagnostics.push(diagnostic);
    for (const phrase of diagnostic.phrasesNotFound) {
      const term = meshTerm(phrase, diagnostic.expression);
      if (!meshLookups.some((lookup) => lookup.phrase === phrase && lookup.term === term)) meshLookups.push(await lookupMesh(phrase, diagnostic.expression, deps));
    }
  }
  return { diagnostics, meshLookups };
}

export function diagnosticOutcome(diagnostics: Diagnostic[]): Outcome {
  for (const status of ['network_error', 'syntax_error', 'other_error', 'zero'] as const) {
    if (diagnostics.some((item) => item.status === status)) return status;
  }
  return 'ok';
}
