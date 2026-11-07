// ヘルプ小節と、履歴を持たない一問一答の相談結果を表す。
import type { UiLanguage } from '../i18n';
import type { ConsultProviderId } from './model';

export type HelpLanguage = UiLanguage;

export interface HelpSection {
  id: string;
  kind: 'section' | 'troubleshooting' | 'faq';
  sectionId: string;
  sectionTitle: string;
  title: string;
  when: string[];
  body: string;
}

export type ConsultFailureKind = 'no_key' | 'permission_missing' | 'rate_limited' | 'auth'
  | 'timeout' | 'aborted' | 'network' | 'invalid_response' | 'truncated' | 'unknown';

export type ConsultResult =
  | { status: 'success'; providerId: ConsultProviderId; model: string; sectionIds: string[]; answer: string }
  | { status: 'no_match' }
  | { status: 'failure'; kind: ConsultFailureKind };
