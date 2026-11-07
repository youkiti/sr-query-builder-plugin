import { commonJa, commonEn } from './common';
import { shellJa, shellEn } from './shell';
import { guideJa, guideEn } from './guide';
import { homeJa, homeEn } from './home';
import { protocolJa, protocolEn } from './protocol';
import { blocksJa, blocksEn } from './blocks';
import { seedsJa, seedsEn } from './seeds';
import { draftJa, draftEn } from './draft';
import { expandJa, expandEn } from './expand';
import { editJa, editEn } from './edit';
import { exportJa, exportEn } from './export';
import { doneJa, doneEn } from './done';
import { historyJa, historyEn } from './history';
import { settingsJa, settingsEn } from './settings';
import { popupJa, popupEn } from './popup';
import { optionsJa, optionsEn } from './options';

export const messageAreas = {
  common: { ja: commonJa, en: commonEn },
  shell: { ja: shellJa, en: shellEn },
  guide: { ja: guideJa, en: guideEn },
  home: { ja: homeJa, en: homeEn },
  protocol: { ja: protocolJa, en: protocolEn },
  blocks: { ja: blocksJa, en: blocksEn },
  seeds: { ja: seedsJa, en: seedsEn },
  draft: { ja: draftJa, en: draftEn },
  expand: { ja: expandJa, en: expandEn },
  edit: { ja: editJa, en: editEn },
  export: { ja: exportJa, en: exportEn },
  done: { ja: doneJa, en: doneEn },
  history: { ja: historyJa, en: historyEn },
  settings: { ja: settingsJa, en: settingsEn },
  popup: { ja: popupJa, en: popupEn },
  options: { ja: optionsJa, en: optionsEn },
} as const;

export const jaMessages = {
  ...commonJa,
  ...shellJa,
  ...guideJa,
  ...homeJa,
  ...protocolJa,
  ...blocksJa,
  ...seedsJa,
  ...draftJa,
  ...expandJa,
  ...editJa,
  ...exportJa,
  ...doneJa,
  ...historyJa,
  ...settingsJa,
  ...popupJa,
  ...optionsJa,
} as const;

export const enMessages = {
  ...commonEn,
  ...shellEn,
  ...guideEn,
  ...homeEn,
  ...protocolEn,
  ...blocksEn,
  ...seedsEn,
  ...draftEn,
  ...expandEn,
  ...editEn,
  ...exportEn,
  ...doneEn,
  ...historyEn,
  ...settingsEn,
  ...popupEn,
  ...optionsEn,
};
