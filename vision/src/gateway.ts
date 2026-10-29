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

export const DEFAULT_MODEL = 'gemini-3.8-flash';
/** 90 s: at 30 s, 2 of the first 4 real plate photos timed out on both passes (Run 3, docs/detection-accuracy.md). */
export const DEFAULT_TIMEOUT_MS = 90_000;
/**
 * Thinking cap for the RETRY of a structured request that timed out (Run 5). Unbounded thinking was
 * the measured cause of the pass 2 timeouts: IMG_2706's pass 2 thought for 28,718 tokens (227.6 s)
 * to answer 199 tokens, and with the fixed seed an identical retry thinks just as long. The same
 * request capped at 1024 answered in 14.0 s and found the pie. A general 8192 cap did not stop
 * the timeout (measured), so first attempts keep the model's default thinking (unchanged results)
 * and only a timed-out request is retried with this cap. Env GEMINI_TIMEOUT_RETRY_THINKING_BUDGET
 * (a number, or "off" for identical retries).
 */
export const DEFAULT_TIMEOUT_RETRY_THINKING_BUDGET = 1024;
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
  /** Thinking-token budget (thinking models). Omitted = the model's default (dynamic). */
  thinkingBudget?: number;
  /** A short name for timing logs, e.g. 'localize-pass1'. Never sent to the provider. */
  label?: string;
}

/** One provider attempt, reported to `onCall` (timing and output size; never the API key). */
export interface GatewayCallRecord {
  label: string;
  kind: GatewayRequest['kind'];
  /** 0 = first try, 1+ = retries. */
  attempt: number;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  /** Characters of the answer text (when there was one). */
  outputChars?: number;
  /** The answer text, for the caller's own analysis (e.g. counting boxes). */
  text?: string;
  finishReason?: string | undefined;
  /** Token counts from the provider's usage metadata, when it sent them. */
  usage?: { promptTokens?: number | undefined; outputTokens?: number | undefined; thoughtsTokens?: number | undefined; totalTokens?: number | undefined };
  /** The request settings actually sent (values, not keys). */
  settings: { model: string; temperature?: number; seed: number | null; maxOutputTokens?: number; thinkingBudget: number | 'model default'; timeoutMs: number };
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
  /** Defaults to env GEMINI_MODEL, then 'gemini-3.8-flash'. */
  model?: string;
  /** Per-request timeout. Defaults to env GEMINI_TIMEOUT_MS, then 90000. */
  timeoutMs?: number;
  /** Thinking cap for structured requests. Env GEMINI_THINKING_BUDGET; unset/null = the model's default. */
  structuredThinkingBudget?: number | null;
  /** Thinking cap for retrying a timed-out structured request. Env GEMINI_TIMEOUT_RETRY_THINKING_BUDGET, then 1024; null = identical retry. */
  timeoutRetryThinkingBudget?: number | null;
  /** Bounded retries after the first attempt. Env GEMINI_MAX_RETRIES, then 2. */
  maxRetries?: number;
  /** Exponential backoff base. Env GEMINI_RETRY_BASE_DELAY_MS, then 500. */
  retryBaseDelayMs?: number;
  /** Called after every provider attempt (timing/size diagnostics). Errors thrown here are ignored. */
  onCall?: (record: GatewayCallRecord) => void;
  /** Fixture responder for mock mode; a default canned responder is used if omitted. */
  mockTransport?: MockTransport;
  /** Injectable for tests; defaults to real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable env for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Fixed sampling seed (D5). Env GEMINI_SEED (integer, or 'off' to omit), default 42. */
  seed?: number | null;
  /** Optional sampling caps. Env GEMINI_TOP_K / GEMINI_TOP_P; omitted when unset. */
  topK?: number;
  topP?: number;
}

export interface GeminiGateway {
  readonly model: string;
  readonly mode: GatewayMode;
  /** How many provider calls were attempted (for tests/observability). */
  readonly callCount: number;
  /** Per-request timeout in ms (env GEMINI_TIMEOUT_MS, default 90000). */
  readonly timeoutMs: number;
  /** Thinking cap sent with structured requests (env GEMINI_THINKING_BUDGET); null = none sent (model default). */
  readonly structuredThinkingBudget: number | null;
  /** Thinking cap for the retry after a GEMINI_TIMEOUT (default 1024); null = identical retry. */
  readonly timeoutRetryThinkingBudget: number | null;
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

const DEFAULT_SEED = 42;

class GatewayImpl implements GeminiGateway {
  readonly model: string;
  private readonly seed: number | null;
  private readonly topK: number | undefined;
  private readonly topP: number | undefined;
  readonly mode: GatewayMode;
  callCount = 0;

  readonly timeoutMs: number;
  readonly structuredThinkingBudget: number | null;
  readonly timeoutRetryThinkingBudget: number | null;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mockTransport: MockTransport;
  private readonly onCall: ((record: GatewayCallRecord) => void) | undefined;
  private readonly client: GoogleGenAI | undefined;

  constructor(opts: GeminiGatewayOptions) {
    const env = opts.env ?? process.env;
    const apiKey = opts.apiKey ?? env['GEMINI_API_KEY'];
    this.model = opts.model ?? env['GEMINI_MODEL'] ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? parsePositiveInt(env['GEMINI_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS);
    const tb = env['GEMINI_THINKING_BUDGET']?.trim();
    this.structuredThinkingBudget =
      opts.structuredThinkingBudget !== undefined ? opts.structuredThinkingBudget : tb && /^\d+$/.test(tb) ? Number(tb) : null;
    const rb = env['GEMINI_TIMEOUT_RETRY_THINKING_BUDGET']?.trim();
    this.timeoutRetryThinkingBudget =
      opts.timeoutRetryThinkingBudget !== undefined
        ? opts.timeoutRetryThinkingBudget
        : rb === 'off'
          ? null
          : parsePositiveInt(rb, DEFAULT_TIMEOUT_RETRY_THINKING_BUDGET);
    const seedRaw = env['GEMINI_SEED']?.trim();
    this.seed = opts.seed !== undefined ? opts.seed : seedRaw === 'off' ? null : parsePositiveInt(seedRaw, DEFAULT_SEED);
    const num = (raw: string | undefined) => (raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined);
    this.topK = opts.topK ?? num(env['GEMINI_TOP_K']);
    this.topP = opts.topP ?? num(env['GEMINI_TOP_P']);
    this.maxRetries = opts.maxRetries ?? parsePositiveInt(env['GEMINI_MAX_RETRIES'], DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ?? parsePositiveInt(env['GEMINI_RETRY_BASE_DELAY_MS'], DEFAULT_RETRY_BASE_DELAY_MS);
    this.sleep = opts.sleep ?? defaultSleep;
    this.mockTransport = opts.mockTransport ?? defaultMockTransport;
    this.onCall = opts.onCall;

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

  private async dispatch(original: GatewayRequest): Promise<string> {
    const attempts = this.maxRetries + 1;
    let lastError: GatewayError | undefined;
    let req = original;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (lastError?.apiError.code === 'GEMINI_TIMEOUT' && req.kind === 'structured' && this.timeoutRetryThinkingBudget !== null) {
        // An identical retry thinks just as long (fixed seed): retry a timed-out request with less thinking.
        const current = this.thinkingBudgetFor(req);
        req = { ...req, thinkingBudget: Math.min(current ?? Infinity, this.timeoutRetryThinkingBudget) };
      }
      const meta: CallMeta = {};
      const started = Date.now();
      try {
        this.callCount++;
        const text = await this.callOnce(req, meta);
        this.report(req, attempt, started, meta, { ok: true, text });
        return text;
      } catch (err) {
        lastError = err instanceof GatewayError ? err : new GatewayError(normalizeProviderError(err));
        this.report(req, attempt, started, meta, { ok: false, errorCode: lastError.apiError.code });
        if (!lastError.apiError.retryable || attempt === attempts - 1) break;
        await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastError ?? new GatewayError(makeApiError('VISION_INTERNAL', 'No attempt was made.', false));
  }

  private report(req: GatewayRequest, attempt: number, started: number, meta: CallMeta, out: { ok: boolean; text?: string; errorCode?: string }): void {
    if (!this.onCall) return;
    try {
      this.onCall({
        label: req.label ?? req.kind,
        kind: req.kind,
        attempt,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        ok: out.ok,
        ...(out.errorCode ? { errorCode: out.errorCode } : {}),
        ...(out.text !== undefined ? { outputChars: out.text.length, text: out.text } : {}),
        ...(meta.finishReason ? { finishReason: meta.finishReason } : {}),
        ...(meta.usage ? { usage: meta.usage } : {}),
        settings: {
          model: this.model,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          seed: this.seed,
          ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
          thinkingBudget: this.thinkingBudgetFor(req) ?? 'model default',
          timeoutMs: req.timeoutMs ?? this.timeoutMs,
        },
      });
    } catch {
      // diagnostics never break a request
    }
  }

  private thinkingBudgetFor(req: GatewayRequest): number | undefined {
    // Short prose (suggestions): thinking tokens count against maxOutputTokens on
    // thinking models and truncated the answer in the live smoke test, so text
    // requests skip thinking. Structured requests use req.thinkingBudget, else the gateway's cap
    // (GEMINI_THINKING_BUDGET, unset by default), else the model default.
    if (req.kind === 'text') return 0;
    return req.thinkingBudget ?? this.structuredThinkingBudget ?? undefined;
  }

  private async callOnce(req: GatewayRequest, meta: CallMeta = {}): Promise<string> {
    if (this.mode === 'mock') {
      return await this.mockTransport(req);
    }
    const thinkingBudget = this.thinkingBudgetFor(req);
    const client = this.client!;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const response = await client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: req.parts }],
      config: {
        abortSignal: AbortSignal.timeout(timeoutMs),
        ...(req.systemInstruction !== undefined ? { systemInstruction: req.systemInstruction } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(this.seed !== null ? { seed: this.seed } : {}),
        ...(this.topK !== undefined ? { topK: this.topK } : {}),
        ...(this.topP !== undefined ? { topP: this.topP } : {}),
        ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.kind === 'structured' ? { responseMimeType: 'application/json', responseSchema: req.responseSchema as object } : {}),
        ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
      },
    });
    const u = response.usageMetadata;
    meta.finishReason = response.candidates?.[0]?.finishReason;
    if (u) meta.usage = { promptTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, thoughtsTokens: u.thoughtsTokenCount, totalTokens: u.totalTokenCount };
    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      throw new GatewayError(
        makeApiError(
          'GEMINI_TRUNCATED_RESPONSE',
          'The analysis service stopped before finishing its answer.',
          false,
          { maxOutputTokens: req.maxOutputTokens },
        ),
      );
    }
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

interface CallMeta {
  finishReason?: string | undefined;
  usage?: GatewayCallRecord['usage'];
}

export function createGeminiGateway(opts: GeminiGatewayOptions = {}): GeminiGateway {
  return new GatewayImpl(opts);
}
