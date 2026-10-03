/**
 * Server-side Gemini gateway (AGENTS.md 4.1, 4.6).
 *
 * - Wraps the official `@google/genai` SDK; model, timeout, and retry budget
 *   come from options or environment variables.
 * - Mock mode is mandatory: when no GEMINI_API_KEY is available the gateway
 *   serves fixture responses through a `mockTransport`, so the whole pipeline
 *   runs without credentials. Mock mode never claims to be a live test.
 * - Every provider failure is normalized into the contracts ApiError shape
 *   and surfaced as a GatewayError after bounded retries with backoff.
 * - `generateText` is the reusable transport for Agent 6's suggestion
 *   generation; no suggestion business logic lives here.
 */

import { GoogleGenAI } from '@google/genai';
import { GatewayError, makeApiError, normalizeProviderError } from './errors.js';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

export type GatewayMode = 'live' | 'mock';

export interface GatewayTextPart {
  text: string;
}

/** Gemini inline image input; `data` is base64-encoded bytes. */
export interface GatewayInlineDataPart {
  inlineData: { mimeType: string; data: string };
}

export type GatewayPart = GatewayTextPart | GatewayInlineDataPart;

export interface GatewayRequest {
  kind: 'text' | 'structured';
  parts: GatewayPart[];
  systemInstruction?: string;
  /** Gemini responseSchema (SDK Schema shape). Present iff kind=structured. */
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/**
 * Fixture-backed transport used when no API key is configured (and in tests).
 * Receives the full request; returns the raw model text. Throwing here goes
 * through the same error normalization and retry path as a live failure.
 */
export type MockTransport = (req: GatewayRequest) => string | Promise<string>;

export interface GenerateTextOptions {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GeminiGatewayOptions {
  /** Defaults to env GEMINI_API_KEY. Unset => mock mode. */
  apiKey?: string;
  /** Defaults to env GEMINI_MODEL, then 'gemini-2.5-flash'. */
  model?: string;
  /** Per-request timeout. Defaults to env GEMINI_TIMEOUT_MS, then 30000. */
  timeoutMs?: number;
  /** Bounded retries after the first attempt. Env GEMINI_MAX_RETRIES, then 2. */
  maxRetries?: number;
  /** Exponential backoff base. Env GEMINI_RETRY_BASE_DELAY_MS, then 500. */
  retryBaseDelayMs?: number;
  /** Fixture responder for mock mode; a default canned responder is used if omitted. */
  mockTransport?: MockTransport;
  /** Injectable for tests; defaults to real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable env for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface GeminiGateway {
  readonly model: string;
  readonly mode: GatewayMode;
  /** How many provider calls were attempted (for tests/observability). */
  readonly callCount: number;
  /** Raw model text for a schema-constrained request. Throws GatewayError. */
  generateStructured(req: Omit<GatewayRequest, 'kind'>): Promise<string>;
  /** Reusable plain-text generation for Agent 6. Throws GatewayError. */
  generateText(prompt: string, opts?: GenerateTextOptions): Promise<string>;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Built-in mock responder so the pipeline runs with zero configuration.
 * Structured requests get a valid "empty plate" classification; text requests
 * get a clearly-labeled canned string.
 */
export const defaultMockTransport: MockTransport = (req) =>
  req.kind === 'structured'
    ? JSON.stringify({ plateEmpty: true, ambiguous: false, items: [], unknown: [] })
    : '[mock-mode response] Gemini is not configured (GEMINI_API_KEY unset); this is fixture text, not a live model answer.';

class GatewayImpl implements GeminiGateway {
  readonly model: string;
  readonly mode: GatewayMode;
  callCount = 0;

  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mockTransport: MockTransport;
  private readonly client: GoogleGenAI | undefined;

  constructor(opts: GeminiGatewayOptions) {
    const env = opts.env ?? process.env;
    const apiKey = opts.apiKey ?? env['GEMINI_API_KEY'];
    this.model = opts.model ?? env['GEMINI_MODEL'] ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? parsePositiveInt(env['GEMINI_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS);
    this.maxRetries = opts.maxRetries ?? parsePositiveInt(env['GEMINI_MAX_RETRIES'], DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ?? parsePositiveInt(env['GEMINI_RETRY_BASE_DELAY_MS'], DEFAULT_RETRY_BASE_DELAY_MS);
    this.sleep = opts.sleep ?? defaultSleep;
    this.mockTransport = opts.mockTransport ?? defaultMockTransport;

    if (apiKey !== undefined && apiKey !== '' && opts.mockTransport === undefined) {
      this.mode = 'live';
      this.client = new GoogleGenAI({ apiKey });
    } else {
      // No key (or an explicit mock transport) => fixture-backed mock mode.
      this.mode = 'mock';
      this.client = undefined;
    }
  }

  async generateStructured(req: Omit<GatewayRequest, 'kind'>): Promise<string> {
    if (req.responseSchema === undefined) {
      throw new GatewayError(
        makeApiError('VISION_INTERNAL', 'generateStructured requires a responseSchema.', false),
      );
    }
    return this.dispatch({ ...req, kind: 'structured' });
  }

  async generateText(prompt: string, opts: GenerateTextOptions = {}): Promise<string> {
    return this.dispatch({ kind: 'text', parts: [{ text: prompt }], ...opts });
  }

  private async dispatch(req: GatewayRequest): Promise<string> {
    const attempts = this.maxRetries + 1;
    let lastError: GatewayError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        this.callCount++;
        return await this.callOnce(req);
      } catch (err) {
        lastError = new GatewayError(normalizeProviderError(err));
        if (!lastError.apiError.retryable || attempt === attempts - 1) break;
        await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastError ?? new GatewayError(makeApiError('VISION_INTERNAL', 'No attempt was made.', false));
  }

  private async callOnce(req: GatewayRequest): Promise<string> {
    if (this.mode === 'mock') {
      return await this.mockTransport(req);
    }
    const client = this.client!;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const response = await client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: req.parts }],
      config: {
        abortSignal: AbortSignal.timeout(timeoutMs),
        ...(req.systemInstruction !== undefined ? { systemInstruction: req.systemInstruction } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.kind === 'structured'
          ? { responseMimeType: 'application/json', responseSchema: req.responseSchema as object }
          : {}),
      },
    });
    const text = response.text;
    if (text === undefined || text === '') {
      throw new GatewayError(
        makeApiError(
          'GEMINI_EMPTY_RESPONSE',
          'The image analysis service returned no usable answer (possibly blocked content).',
          false,
          { promptFeedback: response.promptFeedback as unknown as Record<string, unknown> | undefined },
        ),
      );
    }
    return text;
  }
}

export function createGeminiGateway(opts: GeminiGatewayOptions = {}): GeminiGateway {
  return new GatewayImpl(opts);
}
