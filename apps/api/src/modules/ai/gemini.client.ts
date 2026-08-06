/**
 * Google Gemini provider.
 *
 * Written against the REST API with `fetch` rather than an SDK. Three reasons:
 *   • the surface we need is one endpoint, so an SDK buys nothing;
 *   • no transitive dependency churn in a container we ship to production;
 *   • we control timeouts, retries and error classification explicitly, which
 *     is exactly what matters when a third-party dependency is on a user-facing
 *     path.
 *
 * Reliability behaviour:
 *   • hard timeout via AbortController (a hung LLM call must not hold a request
 *     socket open indefinitely);
 *   • retries with exponential backoff + jitter, but *only* on 429/5xx/network —
 *     retrying a 400 just burns quota;
 *   • a circuit breaker that stops calling a provider that is clearly down,
 *     so we fail fast to the heuristic fallback instead of adding 25s of latency
 *     to every request during an outage.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../../config/env';
import { createLogger } from '../../lib/logger';
import { AiProviderError } from '../../lib/errors';

const log = createLogger('gemini');

/** Subset of OpenAPI schema that Gemini accepts for `responseSchema`. */
export interface ResponseSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  description?: string;
  properties?: Record<string, ResponseSchema>;
  items?: ResponseSchema;
  required?: string[];
  enum?: string[];
  nullable?: boolean;
}

export interface GenerateOptions {
  /** System-level instruction, sent separately from user content. */
  systemInstruction?: string;
  /** Enforces JSON output matching this shape. */
  responseSchema?: ResponseSchema;
  /** 0 = deterministic. Scoring uses 0.1; creative summaries use 0.4. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning-token budget for Gemini 2.5+ models. Defaults to 0 (disabled).
   *
   * The 2.5 family reasons before answering and bills those "thought" tokens as
   * output. Measured on a lead-scoring call: 463 total tokens with thinking, 105
   * without — 4.4× the cost for the same answer, because scoring against a fixed
   * rubric is classification, not reasoning.
   *
   * It also has a sharp failure mode: thinking consumes `maxOutputTokens` first,
   * so a low cap returns `finishReason: STOP` with *empty text* and no error.
   * Set a non-zero budget only for genuinely open-ended generation.
   */
  thinkingBudget?: number;
}

export interface GenerateResult<T> {
  data: T;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  latencyMs: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Reasoning tokens on Gemini 2.5+. Billed as output, and they consume
     *  `maxOutputTokens` before any answer text is produced. */
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/* -------------------------------------------------------------------------- */
/* Circuit breaker                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately in-process rather than in Redis. Each replica learning
 * independently that the provider is down is fine — the goal is to bound
 * latency, not to achieve consensus, and a shared breaker adds a Redis
 * round-trip to the very path we are trying to make fast.
 */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get isOpen(): boolean {
    if (this.openedAt === 0) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      // Half-open: allow one probe through.
      this.openedAt = 0;
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold && this.openedAt === 0) {
      this.openedAt = Date.now();
      log.error({ failures: this.failures }, 'gemini circuit breaker opened');
    }
  }
}

const breaker = new CircuitBreaker();

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Strips markdown fences that models sometimes emit despite JSON mode. */
const extractJson = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  // Fall back to the outermost brace/bracket pair.
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
};

export const geminiClient = {
  get isConfigured(): boolean {
    return env.aiEnabled;
  },

  get isAvailable(): boolean {
    return env.aiEnabled && !breaker.isOpen;
  },

  /**
   * Sends a prompt and parses the JSON response.
   *
   * Throws `AiProviderError` on any failure. Callers are expected to catch it
   * and degrade — no AI feature in this application is allowed to be the reason
   * a user-facing request fails.
   */
  async generateJson<T>(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult<T>> {
    if (!env.aiEnabled) throw new AiProviderError('AI is not configured on this deployment');
    if (breaker.isOpen) throw new AiProviderError('AI provider is temporarily unavailable (circuit open)');

    const url = `${env.GEMINI_API_BASE}/models/${env.GEMINI_MODEL}:generateContent`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(options.systemInstruction
        ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 2_048,
        responseMimeType: 'application/json',
        ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
        // Off by default — see the note on `thinkingBudget`. Older models that
        // do not support the field ignore it, so this is safe across versions.
        thinkingConfig: { thinkingBudget: options.thinkingBudget ?? 0 },
      },
      // We send customer names and company data. Business content occasionally
      // trips the default safety thresholds (a lead at a firearms retailer, a
      // pharma contact), and a blocked response is worse than no filtering here.
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    const startedAt = Date.now();
    let lastError: Error = new AiProviderError('AI request failed');

    for (let attempt = 0; attempt <= env.GEMINI_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Header auth, not a query parameter — query strings end up in
            // access logs and proxy caches.
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const retryable = RETRYABLE_STATUS.has(response.status);
          log.warn(
            { status: response.status, attempt, retryable, detail: detail.slice(0, 300) },
            'gemini request failed',
          );

          if (!retryable) {
            breaker.recordFailure();
            throw new AiProviderError(`AI provider rejected the request (${response.status})`);
          }
          lastError = new AiProviderError(`AI provider error ${response.status}`);
          throw lastError;
        }

        const payload = (await response.json()) as GeminiResponse;

        if (payload.promptFeedback?.blockReason) {
          breaker.recordSuccess(); // the provider is healthy; this input was refused
          throw new AiProviderError(`Request blocked by provider safety filters`);
        }

        const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          const finish = payload.candidates?.[0]?.finishReason;
          const thoughts = payload.usageMetadata?.thoughtsTokenCount ?? 0;

          /*
           * Empty text with `finishReason: STOP` and a non-zero thought count is
           * the confusing one: the model spent the entire output budget
           * reasoning and never emitted an answer. It looks like a success at
           * the HTTP layer, so name it explicitly rather than letting it surface
           * as "malformed JSON".
           */
          const reason =
            thoughts > 0
              ? `AI spent its entire output budget on reasoning (${thoughts} thought tokens) — raise maxOutputTokens or set thinkingBudget: 0`
              : finish === 'MAX_TOKENS'
                ? 'AI response was truncated — try a smaller batch'
                : `AI returned an empty response (finishReason: ${finish ?? 'unknown'})`;

          log.warn({ finish, thoughts }, 'gemini returned no text');
          throw new AiProviderError(reason);
        }

        let data: T;
        try {
          data = JSON.parse(extractJson(text)) as T;
        } catch {
          log.warn({ preview: text.slice(0, 200) }, 'gemini returned unparseable JSON');
          throw new AiProviderError('AI returned malformed JSON');
        }

        breaker.recordSuccess();
        return {
          data,
          inputTokens: payload.usageMetadata?.promptTokenCount,
          outputTokens: payload.usageMetadata?.candidatesTokenCount,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        const err = error as Error;
        // A non-retryable AiProviderError is final; anything else may be worth
        // one more attempt.
        const isAbort = err.name === 'AbortError';
        const isFinal = err instanceof AiProviderError && !isAbort && !err.message.includes('provider error');

        if (isFinal || attempt === env.GEMINI_MAX_RETRIES) {
          breaker.recordFailure();
          throw err instanceof AiProviderError
            ? err
            : new AiProviderError(isAbort ? 'AI request timed out' : 'AI request failed', { cause: err });
        }

        lastError = err;
        // Exponential backoff with full jitter — synchronised retries from many
        // replicas would otherwise hammer a recovering provider in lockstep.
        const backoff = Math.min(2 ** attempt * 500, 4_000);
        await delay(Math.random() * backoff);
      } finally {
        globalThis.clearTimeout(timer);
      }
    }

    breaker.recordFailure();
    throw lastError;
  },
};
