import { CURRENT_SCHEMA_VERSION } from './project';

describe('CURRENT_SCHEMA_VERSION', () => {
  test('セマンティックバージョン形式の文字列', () => {
    expect(CURRENT_SCHEMA_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });
});
