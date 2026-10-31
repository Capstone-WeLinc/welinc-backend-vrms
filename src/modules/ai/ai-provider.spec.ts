import {
  AiProviderError,
  checkedVectors,
  EMBED_DIMENSIONS,
  normalize,
} from './ai-provider';

const vectorOf = (value: number) => Array<number>(EMBED_DIMENSIONS).fill(value);

describe('normalize', () => {
  it('scales a vector to length 1', () => {
    const [x, y] = normalize([3, 4]);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.8);
  });

  it('rejects an all zero vector instead of dividing by zero', () => {
    expect(() => normalize([0, 0, 0])).toThrow(AiProviderError);
  });
});

describe('checkedVectors', () => {
  it('returns one normalized vector per text, in order', () => {
    const result = checkedVectors([vectorOf(1), vectorOf(2)], 2);
    expect(result).toHaveLength(2);
    for (const vector of result) {
      const length = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      expect(length).toBeCloseTo(1);
    }
  });

  it('rejects a missing reply', () => {
    expect(() => checkedVectors(undefined, 1)).toThrow(
      /Expected 1 embeddings, got 0/,
    );
  });

  it('rejects a reply with fewer vectors than texts (the combined vector bug)', () => {
    expect(() => checkedVectors([vectorOf(1)], 3)).toThrow(
      /Expected 3 embeddings, got 1/,
    );
  });

  it('rejects a vector of the wrong length', () => {
    expect(() => checkedVectors([[1, 2, 3]], 1)).toThrow(
      new RegExp(`Expected ${EMBED_DIMENSIONS} values, got 3`),
    );
  });

  it('rejects a missing vector inside the list', () => {
    expect(() => checkedVectors([undefined], 1)).toThrow(AiProviderError);
  });
});
