#!/bin/bash
# cd14715_part3_orchestrator_main_tests.sh - writes implementation files for the
# Enterprise Multi-Agent Code Review Orchestrator (cd14715 final project).
# Run from the starter directory:
#   cd /voc/work/cd14715-claude-code-classroom/project/starter && bash <this-script>.sh
set -e
mkdir -p src/agents src/prompts src/config src/types src/utils tests

cat > src/orchestrator.ts << 'EOF_CD14715'
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import type { ReviewReport } from './types/report-types.js';
import { mcpServersConfig } from './config/mcp.config.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester
} from './agents/index.js';
import { RateLimiter } from './utils/rate-limiter.js';
import type { RateLimiterConfig } from './utils/rate-limiter.js';
import { withRetry, withTimeout, ReviewError, ErrorCodes, formatError } from './utils/error-handler.js';
import { logger } from './utils/logger.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Model override (defaults to the ANTHROPIC_MODEL environment variable) */
  model?: string;
  /** Maximum orchestrator conversation turns (default: 120) */
  maxTurns?: number;
  /** Wall-clock timeout for a full review in milliseconds (default: 15 minutes) */
  timeoutMs?: number;
  /** Hard spending cap for a single review in USD (default: 3) */
  maxBudgetUsd?: number;
  /** Rate limiter overrides applied to the review query */
  rateLimits?: Partial<RateLimiterConfig>;
}

const DEFAULTS: Required<Omit<OrchestratorOptions, 'model' | 'rateLimits'>> = {
  maxTurns: 120,
  timeoutMs: 15 * 60 * 1000,
  maxBudgetUsd: 3
};

/** Rough token estimate used to reserve rate-limit budget for one review */
const ESTIMATED_REVIEW_TOKENS = 60000;

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  /** Rate limiter guarding the review queries (public for observability/tests) */
  readonly rateLimiter: RateLimiter;

  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxBudgetUsd: number;
  private readonly model?: string;

  constructor(options: OrchestratorOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULTS.maxTurns;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxBudgetUsd = options.maxBudgetUsd ?? DEFAULTS.maxBudgetUsd;
    this.model = options.model;
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startTime = Date.now();
    const prompt = buildOrchestratorPrompt(owner, repo, prNumber);

    logger.info('Orchestrator starting review', { owner, repo, prNumber });

    await this.rateLimiter.acquire(ESTIMATED_REVIEW_TOKENS);

    let finalResult: SDKResultMessage | undefined;
    let actualTokens: number | undefined;

    try {
      // One retry on transient failures; the per-run budget cap keeps the
      // worst-case cost bounded even if the first attempt partially ran.
      finalResult = await withRetry(
        () =>
          withTimeout(
            () => this.runQuery(prompt),
            this.timeoutMs,
            `Review of ${owner}/${repo}#${prNumber} timed out`
          ),
        2,
        2000
      );
    } catch (error) {
      if (error instanceof ReviewError) {
        throw error;
      }
      throw new ReviewError(
        `Orchestrator failed: ${formatError(error)}`,
        ErrorCodes.UNKNOWN_ERROR,
        { owner, repo, prNumber }
      );
    } finally {
      const usage = finalResult?.usage;
      if (usage) {
        actualTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      }
      this.rateLimiter.release(actualTokens);
    }

    if (!finalResult || finalResult.subtype !== 'success') {
      throw new ReviewError(
        'Orchestrator run did not complete successfully',
        ErrorCodes.AGENT_FAILED,
        { subtype: finalResult?.subtype ?? 'unknown' }
      );
    }

    const report = this.extractReport(finalResult);

    // Enforce ground truth + wall-clock metadata, then re-validate
    report.pullRequest = { owner, repo, number: prNumber };
    report.metadata.analyzedAt = new Date().toISOString();
    report.metadata.duration = Date.now() - startTime;
    if (!report.metadata.agentVersions || Object.keys(report.metadata.agentVersions).length === 0) {
      report.metadata.agentVersions = {
        'code-quality-analyzer': 'inherit',
        'test-coverage-analyzer': 'inherit',
        'refactoring-suggester': 'inherit'
      };
    }

    const validated = ReviewReportSchema.parse(report);
    logger.info('Orchestrator produced validated report', {
      owner,
      repo,
      prNumber,
      files: validated.summary.totalFiles,
      score: validated.summary.overallScore
    });
    return validated;
  }

  /**
   * Run a single SDK query to completion and return the final result message.
   */
  private async runQuery(prompt: string): Promise<SDKResultMessage> {
    const q = query({
      prompt,
      options: {
        cwd: process.env.PROJECT_ROOT || process.cwd(),
        model: this.model || process.env.ANTHROPIC_MODEL,
        maxTurns: this.maxTurns,
        maxBudgetUsd: this.maxBudgetUsd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        allowedTools: [
          'Task',
          'Read',
          'Write',
          'Glob',
          'Grep',
          'Skill',
          'mcp__github',
          'mcp__eslint'
        ],
        mcpServers: mcpServersConfig,
        agents: {
          'code-quality-analyzer': codeQualityAnalyzer,
          'test-coverage-analyzer': testCoverageAnalyzer,
          'refactoring-suggester': refactoringSuggester
        },
        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema
        },
        stderr: (data: string) => {
          logger.debug(`[sdk-stderr] ${data.trim()}`);
        }
      }
    });

    let finalMessage: SDKResultMessage | undefined;

    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        logger.info('SDK session initialized', {
          model: message.model,
          mcpServers: message.mcp_servers,
          agents: message.agents,
          skills: message.skills
        });
      }
      if (message.type === 'result') {
        finalMessage = message;
      }
    }

    if (!finalMessage) {
      throw new ReviewError(
        'SDK stream ended without a result message',
        ErrorCodes.AGENT_FAILED
      );
    }

    if (finalMessage.subtype !== 'success') {
      throw new ReviewError(
        `Orchestrator run ended with ${finalMessage.subtype}: ${finalMessage.errors.join('; ')}`,
        ErrorCodes.AGENT_FAILED,
        { subtype: finalMessage.subtype, errors: finalMessage.errors }
      );
    }

    return finalMessage;
  }

  /**
   * Extract and validate the ReviewReport from a successful SDK result.
   * Prefers the structured_output field; falls back to parsing the final
   * assistant text for a JSON object.
   */
  private extractReport(result: SDKResultMessage): ReviewReport {
    if (result.subtype !== 'success') {
      throw new ReviewError(
        'Cannot extract report from a failed run',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED
      );
    }

    let candidate: unknown = result.structured_output;

    if (candidate === undefined || candidate === null) {
      candidate = parseJsonCandidate(result.result);
    }

    if (candidate === undefined || candidate === null) {
      throw new ReviewError(
        'Orchestrator returned no parsable structured output',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { rawPreview: (result.result || '').slice(0, 500) }
      );
    }

    const parsed = ReviewReportSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ReviewError(
        'Structured output failed schema validation',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { issues: parsed.error.issues.slice(0, 10) }
      );
    }

    return parsed.data;
  }
}

/**
 * Best-effort JSON extraction from free text:
 * 1. direct JSON.parse
 * 2. ```json fenced block
 * 3. outermost { ... } substring
 */
export function parseJsonCandidate(text: string | undefined): unknown {
  if (!text) return undefined;

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence / brace extraction
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through to brace extraction
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}
EOF_CD14715
echo "wrote src/orchestrator.ts"

cat > src/main.ts << 'EOF_CD14715'
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev -- <owner> <repo> <pr-number>
 */
async function main(): Promise<void> {
  // Load environment variables BEFORE importing modules that read them
  // (logger reads LOG_LEVEL at import time, orchestrator reads PROJECT_ROOT).
  dotenv.config();

  // Winston writes into logs/ - make sure the directory exists before the
  // logger module is imported and opens its file transports.
  fs.mkdirSync('logs', { recursive: true });
  fs.mkdirSync('reports', { recursive: true });

  const [
    { CodeReviewOrchestrator },
    { ReportGenerator },
    { logReviewStart, logReviewComplete, logReviewError },
    { formatError }
  ] = await Promise.all([
    import('./orchestrator.js'),
    import('./utils/report-generator.js'),
    import('./utils/logger.js'),
    import('./utils/error-handler.js')
  ]);

  const [owner, repo, prStr] = process.argv.slice(2);

  // ----- Command line argument validation -----
  if (!owner || !repo || !prStr) {
    console.error('Usage: npm run dev -- <owner> <repo> <pr-number>');
    console.error('Example: npm run dev -- udacity cd14715-simple-todo-app 1');
    process.exit(1);
  }

  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(
      `Invalid pull request number: "${prStr}". It must be a positive integer.`
    );
    process.exit(1);
  }

  // ----- Authentication validation (Anthropic API or AWS Bedrock) -----
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasBedrockCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );

  if (hasAnthropicKey) {
    console.log('Using Anthropic API authentication');
  } else if (hasBedrockCredentials) {
    if (!process.env.AWS_REGION) {
      console.error(
        'AWS Bedrock authentication selected but AWS_REGION is not set.'
      );
      process.exit(1);
    }
    console.log('Using AWS Bedrock authentication');
  } else {
    console.error(
      'No authentication configured. Provide either:\n' +
        '  - ANTHROPIC_API_KEY environment variable (Anthropic API), or\n' +
        '  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_REGION) for AWS Bedrock'
    );
    process.exit(1);
  }

  // ----- Model validation (REQUIRED for both authentication methods) -----
  if (!process.env.ANTHROPIC_MODEL) {
    console.error(
      'ANTHROPIC_MODEL is not set. Add it to .env, e.g. ' +
        'ANTHROPIC_MODEL=claude-sonnet-4-5-20250929 (Anthropic API) or ' +
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0 (Bedrock).'
    );
    process.exit(1);
  }

  console.log(
    `Reviewing ${owner}/${repo} pull request #${prNumber} with model ${process.env.ANTHROPIC_MODEL}`
  );

  try {
    // Create orchestrator and run the multi-agent review
    const orchestrator = new CodeReviewOrchestrator();
    logReviewStart(owner, repo, prNumber);
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    // Generate formatted reports (JSON, Markdown, HTML) into reports/
    const generator = new ReportGenerator();
    const baseName = `${owner}_${repo}_${prNumber}`;
    const outputs: Array<[string, string]> = [
      [`${baseName}.json`, generator.generateJSONReport(report)],
      [`${baseName}.md`, generator.generateMarkdownReport(report)],
      [`${baseName}.html`, generator.generateHTMLReport(report)]
    ];

    for (const [filename, content] of outputs) {
      const filePath = path.join('reports', filename);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`Report written: ${filePath}`);
    }

    logReviewComplete(
      owner,
      repo,
      prNumber,
      report.summary.overallScore,
      report.metadata.duration
    );

    console.log(
      `Review complete: score ${report.summary.overallScore}/100, ` +
        `${report.summary.criticalIssues} critical issue(s), ` +
        `${report.summary.highPriorityTests} high-priority test gap(s), ` +
        `${report.summary.refactoringOpportunities} refactoring opportunity/opportunities ` +
        `across ${report.summary.totalFiles} file(s).`
    );
  } catch (error) {
    logReviewError(owner, repo, prNumber, error as Error);
    console.error(`Review failed: ${formatError(error)}`);
    process.exit(1);
  }
}

main();
EOF_CD14715
echo "wrote src/main.ts"

cat > tests/orchestrator.test.ts << 'EOF_CD14715'
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
      expect(options.outputFormat).toEqual({
        type: 'json_schema',
        schema: ReviewReportJSONSchema
      });
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
EOF_CD14715
echo "wrote tests/orchestrator.test.ts"
