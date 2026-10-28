import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';

/**
 * Code Quality Analyzer subagent
 *
 * Minimal toolset: reads the target file, greps neighbors for context,
 * and consults the project's javascript-best-practices skill.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Analyzes JavaScript/TypeScript files for code quality issues: security, performance, maintainability, style, bug risks and best-practice violations. Returns strict JSON findings.',
  model: 'inherit',
  tools: ['Read', 'Grep', 'Glob', 'Skill'],
  prompt: CODE_QUALITY_ANALYZER_PROMPT
};
