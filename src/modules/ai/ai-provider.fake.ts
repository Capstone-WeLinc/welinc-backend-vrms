import {
  AiProvider,
  AiProviderError,
  EMBED_DIMENSIONS,
  EmbedTask,
  normalize,
} from './ai-provider';

/** A deterministic vector per text, so equal texts are similarity 1. */
export function fakeVector(text: string): number[] {
  const vector = Array.from({ length: EMBED_DIMENSIONS }, (_, i) =>
    Math.sin((i + 1) * (text.length + 1)),
  );
  for (const [i, char] of [...text].entries()) {
    vector[i % EMBED_DIMENSIONS] += char.charCodeAt(0) / 100;
  }
  return normalize(vector);
}

/** Serves the tests: set `reply` or `failWith` before a call. */
export class FakeAiProvider implements AiProvider {
  readonly generationModel = 'fake-model';
  embedModel = 'fake-embed';
  configured = true;
  reply: unknown = null;
  failWith: AiProviderError | null = null;
  readonly embedCalls: { texts: string[]; task: EmbedTask }[] = [];
  readonly prompts: string[] = [];

  embed(texts: string[], task: EmbedTask): Promise<number[][]> {
    this.embedCalls.push({ texts, task });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(texts.map(fakeVector));
  }

  generateJson<T>(prompt: string): Promise<T> {
    this.prompts.push(prompt);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.reply as T);
  }
}
