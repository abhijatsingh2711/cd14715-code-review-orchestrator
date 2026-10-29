import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewReport } from './types/report-types.js';
import { ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
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
        outputFormat: {
          type: 'json_schema',
          schema: ReviewReportJSONSchema
        },
        agents: {
          'code-quality-analyzer': codeQualityAnalyzer,
          'test-coverage-analyzer': testCoverageAnalyzer,
          'refactoring-suggester': refactoringSuggester
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
