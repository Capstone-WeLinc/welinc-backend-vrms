import {
  AiProviderError,
  EMBED_BATCH_SIZE,
  EMBED_DIMENSIONS,
} from './ai-provider';

type Request = { contents: unknown; config: Record<string, unknown> };
const embedContent = jest.fn<Promise<unknown>, [Request]>();
const generateContent = jest.fn<Promise<unknown>, [Request]>();
const GoogleGenAI = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: function (this: object, ...args: unknown[]) {
    GoogleGenAI(...args);
    Object.assign(this, { models: { embedContent, generateContent } });
  },
}));

import type { ConfigService } from '@nestjs/config';
import { validateEnv, testEnv, type Env } from '../../config/env';
import { GeminiProvider } from './gemini.provider';

/** The provider over a checked environment, so the schema's defaults apply (spec 0010). */
function provider(extra: Record<string, string> = {}) {
  const env = validateEnv({ ...testEnv, ...extra });
  const config = {
    get: (key: keyof Env) => env[key],
  } as unknown as ConfigService<Env, true>;
  return new GeminiProvider(config);
}

beforeEach(() => {
  jest.clearAllMocks();
});

function providerWithKey() {
  return provider({ GEMINI_API_KEY: 'test-key' });
}

const vector = () => Array<number>(EMBED_DIMENSIONS).fill(1);

describe('GeminiProvider configuration (AC-10, AC-20)', () => {
  it('is not configured and builds no client without a key', () => {
    const plain = provider();
    expect(plain.configured).toBe(false);
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });

  it('is configured when a key is set', () => {
    expect(providerWithKey().configured).toBe(true);
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });

  it('uses the default model names', () => {
    const plain = provider();
    expect(plain.generationModel).toBe('gemini-3.5-flash-lite');
    expect(plain.embedModel).toBe('gemini-embedding-2');
  });

  it('takes model names from the environment', () => {
    const custom = provider({
      GEMINI_MODEL: 'custom-gen',
      GEMINI_EMBED_MODEL: 'custom-embed',
    });
    expect(custom.generationModel).toBe('custom-gen');
    expect(custom.embedModel).toBe('custom-embed');
  });

  it('fails embed and generate with AiProviderError when no key is set', async () => {
    const plain = provider();
    await expect(plain.embed(['a'], 'RETRIEVAL_DOCUMENT')).rejects.toThrow(
      AiProviderError,
    );
    await expect(plain.generateJson('p', {})).rejects.toThrow(AiProviderError);
  });
});

describe('GeminiProvider.embed', () => {
  it('sends one content per text and returns normalized vectors', async () => {
    embedContent.mockResolvedValue({
      embeddings: [{ values: vector() }, { values: vector() }],
    });

    const result = await providerWithKey().embed(
      ['one', 'two'],
      'RETRIEVAL_QUERY',
    );

    const request = embedContent.mock.calls[0][0];
    expect(request.contents).toEqual([
      { parts: [{ text: 'one' }] },
      { parts: [{ text: 'two' }] },
    ]);
    expect(request.config.taskType).toBe('RETRIEVAL_QUERY');
    expect(request.config.outputDimensionality).toBe(EMBED_DIMENSIONS);
    expect(result).toHaveLength(2);
    expect(Math.hypot(...result[0])).toBeCloseTo(1);
  });

  it('refuses more texts than the batch size without calling the SDK', async () => {
    const texts = Array<string>(EMBED_BATCH_SIZE + 1).fill('x');
    await expect(
      providerWithKey().embed(texts, 'RETRIEVAL_DOCUMENT'),
    ).rejects.toThrow(/At most 50 texts/);
    expect(embedContent).not.toHaveBeenCalled();
  });

  it('wraps an SDK failure in AiProviderError and keeps the cause', async () => {
    const boom = new Error('429 quota');
    embedContent.mockRejectedValue(boom);

    const error = await providerWithKey()
      .embed(['a'], 'RETRIEVAL_DOCUMENT')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).message).toBe('429 quota');
    expect((error as AiProviderError).cause).toBe(boom);
  });

  it('rejects a reply that holds one combined vector for many texts', async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: vector() }] });
    await expect(
      providerWithKey().embed(['a', 'b'], 'RETRIEVAL_DOCUMENT'),
    ).rejects.toThrow(/Expected 2 embeddings, got 1/);
  });
});

describe('GeminiProvider.generateJson', () => {
  it('asks for JSON with the schema and parses the reply', async () => {
    generateContent.mockResolvedValue({ text: '{"causes":["pads"]}' });
    const schema = { type: 'object' };

    const result = await providerWithKey().generateJson<{ causes: string[] }>(
      'diagnose',
      schema,
    );

    expect(result).toEqual({ causes: ['pads'] });
    const request = generateContent.mock.calls[0][0];
    expect(request.contents).toBe('diagnose');
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseSchema).toBe(schema);
  });

  it('fails when the reply has no text (a safety block)', async () => {
    generateContent.mockResolvedValue({ text: undefined });
    await expect(providerWithKey().generateJson('p', {})).rejects.toThrow(
      'The reply had no text',
    );
  });

  it('fails when the reply is not valid JSON', async () => {
    generateContent.mockResolvedValue({ text: 'not json' });
    await expect(providerWithKey().generateJson('p', {})).rejects.toThrow(
      'The reply was not valid JSON',
    );
  });

  it('wraps a network failure in AiProviderError', async () => {
    generateContent.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      providerWithKey().generateJson('p', {}),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});
