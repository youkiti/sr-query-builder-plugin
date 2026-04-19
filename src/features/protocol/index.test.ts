import * as mod from './index';

describe('features/protocol index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.parseMarkdownFile).toBe('function');
    expect(typeof mod.parseDocxFile).toBe('function');
    expect(typeof mod.parseManualProtocol).toBe('function');
    expect(typeof mod.buildPreview).toBe('function');
    expect(typeof mod.PREVIEW_MAX_LENGTH).toBe('number');
    expect(typeof mod.appendProtocol).toBe('function');
    expect(typeof mod.appendProtocolBlocks).toBe('function');
    expect(typeof mod.getNextProtocolVersion).toBe('function');
  });
});
