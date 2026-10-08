// UI 文言辞書（英語）。ja.ts と同じキー集合を型で強制する。
import type { MessageKey } from './ja';

export const en: Record<MessageKey, string> = {
  // ツアー共通
  'guide.openTours': 'Tours',
  'guide.suggest': 'Take a guided tour to see how the screens fit together.',
  'guide.startSuggested': 'Take the tour',
  'guide.postpone': 'Later',
  'guide.suppress': 'Do not suggest again',
  'guide.closeList': 'Close list',
  'guide.done': 'Done',
  'guide.start': 'Start',
  'guide.waiting': 'Waiting for the target to appear.',
  'guide.goRoute': 'Go to this screen',
  'guide.skip': 'Skip this action',
  'guide.complete': 'Finish',
  'guide.next': 'Next',
  'guide.end': 'End tour',
  'guide.language': 'Language',
  'guide.languageJa': '日本語',
  'guide.languageEn': 'English',
  // ツアー: getting-started
  'guide.tourGettingStartedTitle': 'Getting started',
  'guide.tourGettingStartedDesc': 'A short walk through the screen layout, ending at the protocol screen.',
  'guide.tourGettingStartedStepWelcome': 'The list on the left is the order of work. Going from top to bottom produces a search formula.',
  'guide.tourGettingStartedStepOpenProtocol': 'Open “Protocol”. This is where you enter the research purpose and the inclusion and exclusion criteria.',
  'guide.tourGettingStartedStepFinish': 'You can start this tour again from here at any time.',
};
