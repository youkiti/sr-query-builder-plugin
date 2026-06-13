import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema';

describe('schema helpers', () => {
  test('objectSchema は既定で全プロパティ required + additionalProperties:false', () => {
    expect(
      objectSchema({ a: stringSchema(), b: stringSchema() })
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  test('objectSchema は required を明示できる', () => {
    const s = objectSchema({ a: stringSchema(), b: stringSchema() }, ['a']);
    expect(s['required']).toEqual(['a']);
  });

  test('stringSchema は description 任意', () => {
    expect(stringSchema()).toEqual({ type: 'string' });
    expect(stringSchema('d')).toEqual({ type: 'string', description: 'd' });
  });

  test('arraySchema は items を包む', () => {
    expect(arraySchema(stringSchema())).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  test('enumSchema は string + enum', () => {
    expect(enumSchema(['x', 'y'])).toEqual({ type: 'string', enum: ['x', 'y'] });
  });
});
