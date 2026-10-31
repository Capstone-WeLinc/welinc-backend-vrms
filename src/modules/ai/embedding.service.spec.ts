import {
  embeddingText,
  selectStale,
  textHash,
  vectorLiteral,
} from './embedding.service';

const MODEL = 'gemini-embedding-2';

function row(
  id: string,
  description: string,
  stored?: Partial<{ model: string; textHash: string }>,
) {
  return {
    id,
    description,
    model: stored ? (stored.model ?? MODEL) : null,
    textHash: stored
      ? (stored.textHash ?? textHash(embeddingText(description)))
      : null,
  };
}

describe('embedding text and hash (AC-14)', () => {
  it('embeds the description without its category prefix', () => {
    expect(embeddingText('[Brakes] Pads worn: squeal on stop')).toBe(
      'Pads worn: squeal on stop',
    );
  });

  it('hashes the text with SHA 256 hex', () => {
    expect(textHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('writes a vector in pgvector text form', () => {
    expect(vectorLiteral([0.1, 0.2])).toBe('[0.1,0.2]');
  });
});

describe('selectStale (AC-15)', () => {
  it('picks issues with no embedding', () => {
    expect(selectStale([row('a', 'x')], MODEL, 10).map((i) => i.id)).toEqual([
      'a',
    ]);
  });

  it('skips an issue whose model and hash are current', () => {
    expect(selectStale([row('a', 'x', {})], MODEL, 10)).toEqual([]);
  });

  it('picks an issue embedded by another model', () => {
    const rows = [row('a', 'x', { model: 'gemini-embedding-001' })];
    expect(selectStale(rows, MODEL, 10).map((i) => i.id)).toEqual(['a']);
  });

  it('picks an issue whose text changed since it was embedded', () => {
    const rows = [row('a', 'new text', { textHash: textHash('old text') })];
    expect(selectStale(rows, MODEL, 10).map((i) => i.id)).toEqual(['a']);
  });

  it('keeps the oldest first order and stops at the limit', () => {
    const rows = [row('a', '1'), row('b', '2'), row('c', '3')];
    expect(selectStale(rows, MODEL, 2).map((i) => i.id)).toEqual(['a', 'b']);
  });
});
