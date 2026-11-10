import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import type { Env } from '../../config/env';
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

/**
 * Gemini through @google/genai, the only file that imports it. Settings and their defaults come
 * from the env schema (spec 0013, spec 0010); a missing key is warned about at boot (envWarnings).
 */
@Injectable()
export class GeminiProvider implements AiProvider {
  private readonly client: GoogleGenAI | null;
  readonly generationModel: string;
  readonly embedModel: string;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    this.generationModel = config.get('GEMINI_MODEL', { infer: true });
    this.embedModel = config.get('GEMINI_EMBED_MODEL', { infer: true });
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
        // One content per text: a plain string array is read as parts of ONE content, and
        // gemini-embedding-2 then returns a single combined vector (checked 2026-10-31)
        contents: texts.map((text) => ({ parts: [{ text }] })),
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
