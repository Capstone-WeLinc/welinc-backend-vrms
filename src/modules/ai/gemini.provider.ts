import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import {
  AiProvider,
  AiProviderError,
  checkedVectors,
  EMBED_BATCH_SIZE,
  EMBED_DIMENSIONS,
  EmbedTask,
} from './ai-provider';

const GENERATE_TIMEOUT_MS = 20_000;
const EMBED_TIMEOUT_MS = 10_000;

// Spec 0013, Configuration required
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_EMBED_MODEL = 'gemini-embedding-2';

/** Gemini through @google/genai, the only file that imports it. */
@Injectable()
export class GeminiProvider implements AiProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client: GoogleGenAI | null;
  readonly generationModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  readonly embedModel = process.env.GEMINI_EMBED_MODEL || DEFAULT_EMBED_MODEL;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    if (!apiKey) {
      this.logger.warn(
        'GEMINI_API_KEY is not set: AI diagnosis answers 503 and embedding is skipped',
      );
    }
  }

  get configured() {
    return this.client !== null;
  }

  async embed(texts: string[], task: EmbedTask): Promise<number[][]> {
    if (texts.length > EMBED_BATCH_SIZE) {
      throw new AiProviderError(
        `At most ${EMBED_BATCH_SIZE} texts per embed call`,
      );
    }
    const response = await this.call(() =>
      this.requireClient().models.embedContent({
        model: this.embedModel,
        contents: texts,
        config: {
          taskType: task,
          outputDimensionality: EMBED_DIMENSIONS,
          abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        },
      }),
    );
    return checkedVectors(
      response.embeddings?.map((e) => e.values),
      texts.length,
    );
  }

  async generateJson<T>(prompt: string, schema: object): Promise<T> {
    const response = await this.call(() =>
      this.requireClient().models.generateContent({
        model: this.generationModel,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        },
      }),
    );
    // A safety block or an empty candidate leaves no text
    const text = response.text;
    if (!text) throw new AiProviderError('The reply had no text');
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AiProviderError('The reply was not valid JSON', { cause });
    }
  }

  private requireClient(): GoogleGenAI {
    if (!this.client) throw new AiProviderError('GEMINI_API_KEY is not set');
    return this.client;
  }

  /** Turns every SDK failure (network, timeout, 4xx, 5xx) into an AiProviderError. */
  private async call<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof AiProviderError) throw cause;
      throw new AiProviderError(
        cause instanceof Error ? cause.message : 'Provider call failed',
        { cause },
      );
    }
  }
}
