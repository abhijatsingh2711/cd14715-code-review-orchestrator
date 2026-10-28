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
