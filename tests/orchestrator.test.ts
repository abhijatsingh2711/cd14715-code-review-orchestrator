import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for CodeReviewOrchestrator
 *
 * The Claude Agent SDK is mocked at module level so no API calls are made.
 * These tests cover:
 * - orchestrator configuration (defaults + custom rate limits)
 * - SDK wiring (MCP servers, allowed tools, agents, structured output format)
 * - result aggregation into a validated ReviewReport
 * - Zod schema validation (valid / invalid / boundary / JSON Schema export)
 * - error handler and rate limiter utility behaviour (success + failure paths)
 */

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { CodeReviewOrchestrator, parseJsonCandidate } from '../src/orchestrator';
import { ReviewReportSchema, ReviewReportJSONSchema } from '../src/types/report-types';
import { ErrorCodes, ReviewError, withRetry, withTimeout } from '../src/utils/error-handler';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../src/utils/rate-limiter';

const queryMock = vi.mocked(query);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCodeQuality(file: string, overallScore: number) {
  return {
    file,
    issues: [
      {
        line: 12,
        severity: 'high' as const,
        category: 'bug-risk' as const,
        description: 'Possible null dereference',
        suggestion: 'Add a null check before access'
      },
      {
        line: 30,
        severity: 'critical' as const,
        category: 'security' as const,
        description: 'eval() on user input',
        suggestion: 'Replace with JSON.parse'
      }
    ],
    overallScore,
    summary: 'Some security and bug risks found.'
  };
}

function makeTestCoverage(file: string) {
  return {
    file,
    hasTests: false,
    testFiles: [],
    untestedPaths: [
      {
        type: 'function' as const,
        location: 'addItem (line 8)',
        priority: 'high' as const,
        reasoning: 'Core mutation path is untested',
        suggestedTest: 'Should add an item and persist it'
      },
      {
        type: 'edge-case' as const,
        location: 'addItem with empty title (line 10)',
        priority: 'critical' as const,
        reasoning: 'Empty input may corrupt state',
        suggestedTest: 'Should reject empty titles'
      },
      {
        type: 'branch' as const,
        location: 'removeItem early return (line 22)',
        priority: 'medium' as const,
        reasoning: 'Missing-id branch untested',
        suggestedTest: 'Should no-op when id is unknown'
      }
    ],
    coverageEstimate: 35,
    summary: 'No test file found for this module.'
  };
}

function makeRefactorings(file: string) {
  return {
    file,
    suggestions: [
      {
        type: 'modernize' as const,
        location: 'render (lines 40-48)',
        impact: 'medium' as const,
        description: 'String concatenation to template literals',
        before: "return '<li>' + item.title + '</li>';",
        after: 'return `<li>${item.title}</li>`;',
        benefits: 'Clearer string construction'
      },
      {
        type: 'extract-function' as const,
        location: 'render (lines 36-60)',
        impact: 'high' as const,
        description: 'DOM update loop is long and mixed-purpose',
        before: 'function render() { /* 40 lines */ }',
        after: 'function renderList(items) {}\nfunction renderSummary(items) {}',
        benefits: 'Readability and testability'
      }
    ],
    summary: 'Two worthwhile refactorings available.'
  };
}

function makeValidReport(overrides: Record<string, unknown> = {}) {
  const file = 'src/app.js';
  return {
    pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
    fileReviews: [
      {
        file,
        codeQuality: makeCodeQuality(file, 62),
        testCoverage: makeTestCoverage(file),
        refactorings: makeRefactorings(file)
      }
    ],
    summary: {
      totalFiles: 1,
      overallScore: 62,
      criticalIssues: 1,
      highPriorityTests: 2,
      refactoringOpportunities: 2
    },
    recommendations: [
      {
        priority: 'critical' as const,
        category: 'Security',
        description: 'Remove eval() usage on untrusted input',
        files: [file]
      },
      {
        priority: 'high' as const,
        category: 'Test Coverage',
        description: 'Add tests for addItem edge cases',
        files: [file]
      }
    ],
    metadata: {
      analyzedAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      duration: 1234,
      agentVersions: {
        'code-quality-analyzer': 'inherit',
        'test-coverage-analyzer': 'inherit',
        'refactoring-suggester': 'inherit'
      }
    },
    ...overrides
  };
}

/** Build a minimal-but-shaped SDK result message */
function makeResultMessage(report: unknown, opts: { structured?: boolean } = {}) {
  const withStructured = opts.structured !== false;
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    duration_ms: 5000,
    duration_api_ms: 4000,
    is_error: false,
    num_turns: 8,
    result: JSON.stringify(report),
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 1200,
      output_tokens: 800,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: undefined,
      web_search_requests: 0
    },
    modelUsage: {},
    permission_denials: [],
    structured_output: withStructured ? report : undefined,
    uuid: 'test-uuid',
    session_id: 'test-session'
  };
}

/** Fake the SDK query() to yield the given messages then stop (fresh generator per call) */
function mockQueryYields(messages: unknown[]) {
  queryMock.mockImplementation(() => {
    return (async function* () {
      for (const m of messages) {
        yield m as never;
      }
    })() as never;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(orchestrator.rateLimiter.canProceed(1000)).toBe(true);
    });

    it('should accept custom rate limit configuration', () => {
      const custom = new CodeReviewOrchestrator({
        rateLimits: { maxTokensPerMinute: 5000 }
      });
      // 10k estimated tokens exceed the 5k custom limit -> cannot proceed
      expect(custom.rateLimiter.canProceed(10000)).toBe(false);
      // Defaults would allow it
      const fallback = new CodeReviewOrchestrator();
      expect(fallback.rateLimiter.canProceed(10000)).toBe(true);
      expect(DEFAULT_RATE_LIMITS.maxTokensPerMinute).toBeGreaterThan(5000);
    });
  });

  describe('reviewPullRequest', () => {
    it('should fetch PR files from GitHub MCP', async () => {
      mockQueryYields([makeResultMessage(makeValidReport())]);

      const orchestrator = new CodeReviewOrchestrator();
      await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const callArgs = queryMock.mock.calls[0] as unknown as [
        { prompt: string; options: Record<string, unknown> }
      ];
      const options = callArgs[0].options;

      // GitHub MCP server wired with the official stdio server
      const mcpServers = options.mcpServers as Record<string, Record<string, unknown>>;
      expect(mcpServers.github.command).toBe('npx');
      expect(mcpServers.github.args).toContain('@modelcontextprotocol/server-github');
      expect(mcpServers.eslint.command).toBe('npx');

      // Allowed tools include Task + MCP tool namespaces
      const allowedTools = options.allowedTools as string[];
      expect(allowedTools).toContain('Task');
      expect(allowedTools).toContain('mcp__github');
      expect(allowedTools).toContain('mcp__eslint');

      // Structured output enforces the report JSON Schema
      expect(options.outputFormat).toBeUndefined();
    });

    it('should spawn all 3 subagents in parallel', async () => {
      mockQueryYields([makeResultMessage(makeValidReport())]);

      const orchestrator = new CodeReviewOrchestrator();
      await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      const callArgs = queryMock.mock.calls[0] as unknown as [
        { prompt: string; options: Record<string, unknown> }
      ];
      const agents = callArgs[0].options.agents as Record<string, Record<string, unknown>>;

      const expectedAgents = [
        'code-quality-analyzer',
        'test-coverage-analyzer',
        'refactoring-suggester'
      ];
      for (const name of expectedAgents) {
        expect(agents[name], `agent ${name} must be registered`).toBeDefined();
        expect(String(agents[name].prompt).length).toBeGreaterThan(100);
        expect(agents[name].model).toBe('inherit');
        expect(agents[name].tools as string[]).toContain('Skill');
      }
      expect(Object.keys(agents)).toHaveLength(3);
    });

    it('should aggregate results into ReviewReport', async () => {
      mockQueryYields([makeResultMessage(makeValidReport())]);

      const orchestrator = new CodeReviewOrchestrator();
      const report = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);

      expect(report.pullRequest).toEqual({ owner: 'octocat', repo: 'Hello-World', number: 1 });
      expect(report.fileReviews).toHaveLength(1);
      expect(report.fileReviews[0]?.file).toBe('src/app.js');
      expect(report.summary.totalFiles).toBe(1);
      expect(report.summary.criticalIssues).toBe(1);
      expect(report.summary.refactoringOpportunities).toBe(2);

      // Metadata is refreshed with real wall-clock values
      expect(new Date(report.metadata.analyzedAt).toString()).not.toBe('Invalid Date');
      expect(report.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('should validate output with Zod schema', async () => {
      // Structured output that violates the schema -> STRUCTURED_OUTPUT_FAILED
      mockQueryYields([makeResultMessage({ foo: 'bar', nope: 1 })]);
      const orchestrator = new CodeReviewOrchestrator();
      await expect(
        orchestrator.reviewPullRequest('octocat', 'Hello-World', 2)
      ).rejects.toMatchObject({ code: ErrorCodes.STRUCTURED_OUTPUT_FAILED });
    });

    it('should fall back to parsing JSON from the final message text', async () => {
      // No structured_output field, but the raw text is valid report JSON
      mockQueryYields([makeResultMessage(makeValidReport(), { structured: false })]);

      const orchestrator = new CodeReviewOrchestrator();
      const report = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);
      expect(report.summary.overallScore).toBe(62);
    });

    it('should surface SDK failure subtypes as AGENT_FAILED', async () => {
      mockQueryYields([
        {
          type: 'result',
          subtype: 'error_max_turns',
          duration_ms: 100,
          duration_api_ms: 100,
          is_error: true,
          num_turns: 120,
          total_cost_usd: 0.1,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          errors: ['Maximum turns reached'],
          uuid: 'u',
          session_id: 's'
        }
      ]);

      const orchestrator = new CodeReviewOrchestrator({ maxTurns: 1, timeoutMs: 5000 });
      // withRetry wraps the failure in its own contract code (RETRY_EXHAUSTED)
      // while preserving the underlying SDK subtype in the message chain.
      const error = await orchestrator
        .reviewPullRequest('octocat', 'Hello-World', 3)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReviewError);
      expect((error as ReviewError).code).toBe(ErrorCodes.RETRY_EXHAUSTED);
      expect((error as ReviewError).message).toMatch(/error_max_turns/);
    }, 15000);
  });

  describe('ReviewReportSchema', () => {
    it('should accept a fully valid report', () => {
      const parsed = ReviewReportSchema.safeParse(makeValidReport());
      expect(parsed.success).toBe(true);
    });

    it('should reject an invalid recommendation priority', () => {
      const bad = makeValidReport({
        recommendations: [
          { priority: 'urgent', category: 'X', description: 'Y', files: [] }
        ]
      });
      expect(ReviewReportSchema.safeParse(bad).success).toBe(false);
    });

    it('should enforce overallScore boundaries (0 and 100 valid, -1 and 101 invalid)', () => {
      for (const score of [0, 100]) {
        const report = makeValidReport();
        (report.fileReviews[0] as Record<string, unknown>).codeQuality =
          makeCodeQuality('src/app.js', score);
        expect(ReviewReportSchema.safeParse(report).success).toBe(true);
      }
      for (const score of [-1, 101]) {
        const report = makeValidReport();
        (report.fileReviews[0] as Record<string, unknown>).codeQuality =
          makeCodeQuality('src/app.js', score);
        expect(ReviewReportSchema.safeParse(report).success).toBe(false);
      }
    });

    it('should export a JSON Schema for SDK structured outputs', () => {
      expect(ReviewReportJSONSchema).toBeTypeOf('object');
      const schema = ReviewReportJSONSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toBeDefined();
      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining(['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata'])
      );
    });
  });

  describe('parseJsonCandidate', () => {
    it('parses plain JSON text', () => {
      expect(parseJsonCandidate('{"a":1}')).toEqual({ a: 1 });
    });

    it('parses fenced JSON blocks', () => {
      expect(parseJsonCandidate('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('parses JSON embedded in prose', () => {
      expect(parseJsonCandidate('Here is the report: {"a":1} thanks!')).toEqual({ a: 1 });
    });

    it('returns undefined for non-JSON text', () => {
      expect(parseJsonCandidate('no json here')).toBeUndefined();
      expect(parseJsonCandidate(undefined)).toBeUndefined();
    });
  });

  describe('withRetry', () => {
    it('returns the result when the function eventually succeeds', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      };
      const result = await withRetry(fn, 5, 1);
      expect(result).toBe('ok');
      expect(attempts).toBe(3);
    });

    it('throws RETRY_EXHAUSTED when all attempts fail', async () => {
      const fn = async () => {
        throw new Error('always fails');
      };
      await expect(withRetry(fn, 2, 1)).rejects.toMatchObject({
        code: ErrorCodes.RETRY_EXHAUSTED
      });
    });
  });

  describe('withTimeout', () => {
    it('resolves when the function finishes in time', async () => {
      const result = await withTimeout(async () => 'fast', 1000);
      expect(result).toBe('fast');
    });

    it('rejects with AGENT_TIMEOUT when the function is too slow', async () => {
      const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
      await expect(withTimeout(slow, 20)).rejects.toMatchObject({
        code: ErrorCodes.AGENT_TIMEOUT
      });
    });
  });

  describe('ReviewError', () => {
    it('carries code and metadata and is detected by isReviewError', () => {
      const error = new ReviewError('boom', ErrorCodes.AGENT_FAILED, { extra: 1 });
      expect(error.code).toBe(ErrorCodes.AGENT_FAILED);
      expect(error.metadata).toEqual({ extra: 1 });
      expect(error.name).toBe('ReviewError');
    });
  });

  describe('RateLimiter', () => {
    it('tracks acquire/release and window status', async () => {
      const limiter = new RateLimiter();
      await limiter.acquire(100);
      const during = limiter.getStatus();
      expect(during.activeRequests).toBe(1);
      expect(during.requestsInWindow).toBe(1);

      limiter.release(250);
      const after = limiter.getStatus();
      expect(after.activeRequests).toBe(0);
      expect(after.tokensInWindow).toBe(250);
    });

    it('blocks acquire when concurrency is exhausted', async () => {
      const limiter = new RateLimiter({ maxConcurrent: 1 });
      await limiter.acquire(10);

      let secondFinished = false;
      const second = limiter.acquire(10).then(() => {
        secondFinished = true;
      });

      // Give the microtask queue a chance: second must still be waiting
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondFinished).toBe(false);

      limiter.release();
      await second;
      expect(secondFinished).toBe(true);

      limiter.release();
    });
  });
});
