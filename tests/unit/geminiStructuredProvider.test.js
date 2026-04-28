'use strict';

/**
 * Unit tests for server/ai/providers/geminiStructuredProvider.js
 *
 * Tests mock the https module so no real network calls are made.
 */

// Mock the https module before requiring the provider
jest.mock('https');

const https = require('https');
const {
  callStructuredGemini,
  RetryableError,
  FatalError,
  RateLimitError
} = require('../../server/ai/providers/geminiStructuredProvider.js');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid Gemini JSON response string.
 */
function makeGeminiResponse(text) {
  return JSON.stringify({
    candidates: [{
      content: { parts: [{ text }] },
      finishReason: 'STOP'
    }]
  });
}

/**
 * Configure https.request mock to serve the given sequence of responses.
 * Each entry is { statusCode, headers?, body }.
 * When req.end() is called, the response callback fires asynchronously
 * AFTER the handlers have been registered.
 */
function mockHttpsRequest(responseSpecs) {
  const EventEmitter = require('events');
  let callIndex = 0;

  https.request.mockImplementation((options, callback) => {
    const spec = responseSpecs[callIndex < responseSpecs.length ? callIndex++ : responseSpecs.length - 1];

    const req = new EventEmitter();
    req.write = jest.fn();
    req.destroy = jest.fn((err) => req.emit('error', err));
    req.end = jest.fn(() => {
      // Simulate async response: call callback first (sets up data/end handlers),
      // then emit data/end in a subsequent nextTick.
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = spec.statusCode;
        res.headers = spec.headers || {};
        // Call the response callback – this is where httpPost sets up handlers
        callback(res);
        // Now emit the body in another tick (handlers are set up now)
        process.nextTick(() => {
          res.emit('data', Buffer.from(spec.body, 'utf8'));
          res.emit('end');
        });
      });
    });
    return req;
  });
}

// ── Setup / Teardown ───────────────────────────────────────────────────────────

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  process.env.AI_ASSESSMENT_MODEL = 'gemini-2.0-flash';
  // Keep retries at defaults unless overridden per test
  delete process.env.AI_ASSESSMENT_MAX_RETRIES;
  delete process.env.AI_ASSESSMENT_RATELIMIT_RETRIES;
  delete process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS;
  // Keep nextTick real so HTTP mock callbacks fire correctly;
  // fake only setTimeout/setInterval so sleep() resolves instantly.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate'] });
  https.request.mockReset();
});

afterEach(() => {
  process.env = originalEnv;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ── Error class tests ──────────────────────────────────────────────────────────

describe('RateLimitError', () => {
  test('is an instance of RetryableError', () => {
    const err = new RateLimitError('test', 5000);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryable).toBe(true);
    expect(err.rateLimit).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
  });

  test('retryAfterMs is undefined when not provided', () => {
    const err = new RateLimitError('test');
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// ── Default behaviour: 429 not retried ────────────────────────────────────────

describe('callStructuredGemini – 429 with RATELIMIT_RETRIES=0 (default)', () => {
  test('makes exactly 1 HTTP call and propagates RateLimitError', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '0';

    mockHttpsRequest([
      { statusCode: 429, body: '{"error":{"code":429,"message":"quota"}}' }
    ]);

    // Use expect(call).rejects so the rejection handler is attached immediately
    await expect(callStructuredGemini({ user: 'hello', system: 'sys' }))
      .rejects.toBeInstanceOf(RateLimitError);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('propagated error has rateLimit=true and statusCode=429', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '0';

    mockHttpsRequest([
      { statusCode: 429, body: '{"error":{"code":429}}' }
    ]);

    // Attach handler immediately to avoid unhandledRejection
    const errP = callStructuredGemini({ user: 'hello' }).catch(e => e);
    const err = await errP;
    expect(err.rateLimit).toBe(true);
    expect(err.statusCode).toBe(429);
  });
});

// ── 429 retried once when RATELIMIT_RETRIES=1 ─────────────────────────────────

describe('callStructuredGemini – 429 with RATELIMIT_RETRIES=1', () => {
  test('makes exactly 2 HTTP calls with Retry-After: 0', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '60000';

    const successBody = makeGeminiResponse('{"ok":true}');
    mockHttpsRequest([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"code":429}}' },
      { statusCode: 200, body: successBody }
    ]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(https.request).toHaveBeenCalledTimes(2);
    expect(result).toBe('{"ok":true}');
    // Should have logged the rate limit sleep message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[gemini\] 429 rate-limited, sleeping \d+ms before retry 1\/1/)
    );
  });

  test('uses Retry-After header value for sleep delay', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    // Set a very short min-delay so only Retry-After matters
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '1000';

    const successBody = makeGeminiResponse('{"result":"ok"}');
    mockHttpsRequest([
      { statusCode: 429, headers: { 'retry-after': '30' }, body: '{"error":{"code":429}}' },
      { statusCode: 200, body: successBody }
    ]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    await promise;

    // 30s Retry-After → 30000ms
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sleeping 30000ms/)
    );
  });

  test('uses retryDelay from body JSON when no header present', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    // Set a very short min-delay so only retryDelay matters
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '1000';

    const body429 = JSON.stringify({
      error: {
        code: 429,
        message: 'quota',
        details: [{ retryDelay: '23s' }]
      }
    });
    const successBody = makeGeminiResponse('{"result":"ok"}');
    mockHttpsRequest([
      { statusCode: 429, body: body429 },
      { statusCode: 200, body: successBody }
    ]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    await promise;

    // 23s retryDelay → 23000ms
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sleeping 23000ms/)
    );
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('falls back to rlMinDelayMs when no Retry-After hint', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '45000';

    const successBody = makeGeminiResponse('{"result":"ok"}');
    mockHttpsRequest([
      { statusCode: 429, body: '{"error":{"code":429}}' },
      { statusCode: 200, body: successBody }
    ]);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    await promise;

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sleeping 45000ms/)
    );
  });

  test('still throws after exhausting rate limit retries', async () => {
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '0';

    mockHttpsRequest([
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"code":429}}' },
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"code":429}}' }
    ]);

    jest.spyOn(console, 'log').mockImplementation(() => {});

    // Attach handler immediately to avoid unhandledRejection
    const errP = callStructuredGemini({ user: 'hello' }).catch(e => e);
    await jest.runAllTimersAsync();
    const err = await errP;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(https.request).toHaveBeenCalledTimes(2);
  });
});

// ── 5xx transient retries unchanged ───────────────────────────────────────────

describe('callStructuredGemini – 5xx transient retries (existing behaviour)', () => {
  test('retries 5xx up to AI_ASSESSMENT_MAX_RETRIES times', async () => {
    process.env.AI_ASSESSMENT_MAX_RETRIES = '2';

    const successBody = makeGeminiResponse('{"result":"ok"}');
    mockHttpsRequest([
      { statusCode: 503, body: 'Service Unavailable' },
      { statusCode: 503, body: 'Service Unavailable' },
      { statusCode: 200, body: successBody }
    ]);

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('{"result":"ok"}');
    expect(https.request).toHaveBeenCalledTimes(3);
  });

  test('throws RetryableError after exhausting MAX_RETRIES', async () => {
    process.env.AI_ASSESSMENT_MAX_RETRIES = '1';

    mockHttpsRequest([
      { statusCode: 500, body: 'Internal Server Error' },
      { statusCode: 500, body: 'Internal Server Error' }
    ]);

    // Attach handler immediately to avoid unhandledRejection
    const errP = callStructuredGemini({ user: 'hello' }).catch(e => e);
    await jest.runAllTimersAsync();
    const err = await errP;

    expect(err).toBeInstanceOf(RetryableError);
    expect(err.rateLimit).toBeFalsy();
    expect(https.request).toHaveBeenCalledTimes(2);
  });

  test('5xx does not consume rate limit retries budget', async () => {
    process.env.AI_ASSESSMENT_MAX_RETRIES = '1';
    process.env.AI_ASSESSMENT_RATELIMIT_RETRIES = '1';
    process.env.AI_ASSESSMENT_RATELIMIT_MIN_DELAY_MS = '0';

    const successBody = makeGeminiResponse('{"result":"ok"}');
    mockHttpsRequest([
      { statusCode: 500, body: 'Internal Server Error' },
      { statusCode: 429, headers: { 'retry-after': '0' }, body: '{"error":{"code":429}}' },
      { statusCode: 200, body: successBody }
    ]);

    jest.spyOn(console, 'log').mockImplementation(() => {});

    const promise = callStructuredGemini({ user: 'hello' });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('{"result":"ok"}');
    // 1 original + 1 transient retry + 1 rate-limit retry = 3 calls
    expect(https.request).toHaveBeenCalledTimes(3);
  });
});

// ── FatalError for 4xx (not 429) ──────────────────────────────────────────────

describe('callStructuredGemini – fatal errors not retried', () => {
  test('throws FatalError for 400 without retrying', async () => {
    mockHttpsRequest([
      { statusCode: 400, body: '{"error":{"code":400}}' }
    ]);

    // Use expect(call).rejects so the rejection handler is attached immediately
    await expect(callStructuredGemini({ user: 'hello' })).rejects.toBeInstanceOf(FatalError);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('throws FatalError when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(callStructuredGemini({ user: 'hello' })).rejects.toBeInstanceOf(FatalError);
    expect(https.request).not.toHaveBeenCalled();
  });
});
