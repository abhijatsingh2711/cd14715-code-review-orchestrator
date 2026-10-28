import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

/**
 * Test Coverage Analyzer subagent
 *
 * Minimal toolset: reads the target file, globs/greps for related test
 * files, and consults the project's javascript-best-practices skill.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Evaluates test coverage for a given file: locates related test files, identifies untested functions, branches and edge cases, and proposes missing tests. Returns strict JSON findings.',
  model: 'inherit',
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  prompt: TEST_COVERAGE_ANALYZER_PROMPT
};
