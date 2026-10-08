import { EutilsError } from './eutils';

export function isQueryRejection(error: unknown): boolean {
  return error instanceof EutilsError && error.permanent && (error.message.startsWith('構文エラー')
    || error.message.startsWith('esearch エラー:') || error.message === 'esearch in-band エラー');
}

// PubMed はこの拒否も Search Backend failed として返すため、一時障害と区別できない。
// ワイルドカード数の上限超過は再試行しても解消しない。
export function isWildcardLimitRejection(error: unknown): boolean {
  return error instanceof EutilsError && /^esearch エラー:/i.test(error.message)
    && /number of wildcards \(\*\) exceeds \d+/i.test(error.message);
}

