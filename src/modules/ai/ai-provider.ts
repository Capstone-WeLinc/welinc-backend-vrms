// Spec 0013: the one seam between VRMS and an AI provider. Only src/modules/ai/ talks to one.

export const AI_PROVIDER = Symbol('AI_PROVIDER');

/** Every vector is this long, so similarity only ever compares like with like. */
export const EMBED_DIMENSIONS = 768;

/** Up to this many texts go in one embed call. */
export const EMBED_BATCH_SIZE = 100;

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface AiProvider {
  /** The generation model's name, stored on each diagnosis. */
  readonly generationModel: string;
  /** The embedding model's name; a stored vector from another model is stale. */
  readonly embedModel: string;
  /** False when no key is set: runs answer AI_UNAVAILABLE and embedding is skipped (AC-20). */
  readonly configured: boolean;
  /** One normalized vector of EMBED_DIMENSIONS per text, in order. */
  embed(texts: string[], task: EmbedTask): Promise<number[][]>;
  /** A JSON answer matching the schema, parsed but not yet validated. */
  generateJson<T>(prompt: string, schema: object): Promise<T>;
}

/** Any provider failure: network, timeout, 4xx or 5xx, a safety block, or a malformed reply. */
export class AiProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}

/** Scales a vector to length 1; cosine similarity then reads the same for every model. */
export function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (!length)
    throw new AiProviderError('The provider returned an empty vector');
  return vector.map((v) => v / length);
}

/** Checks a reply has one vector of the right length per text, then normalizes each. */
export function checkedVectors(
  vectors: (number[] | undefined)[] | undefined,
  count: number,
): number[][] {
  if (!vectors || vectors.length !== count) {
    throw new AiProviderError(
      `Expected ${count} embeddings, got ${vectors?.length ?? 0}`,
    );
  }
  return vectors.map((vector) => {
    if (!vector || vector.length !== EMBED_DIMENSIONS) {
      throw new AiProviderError(
        `Expected ${EMBED_DIMENSIONS} values, got ${vector?.length ?? 0}`,
      );
    }
    return normalize(vector);
  });
}
