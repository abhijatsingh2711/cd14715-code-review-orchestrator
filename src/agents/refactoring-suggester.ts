import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

/**
 * Refactoring Suggester subagent
 *
 * Minimal toolset: reads the target file, globs for structural context,
 * and consults the project's javascript-best-practices skill.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Recommends concrete refactoring opportunities for a given file: extract-function, rename, modernize, simplify and pattern improvements, with before/after snippets. Returns strict JSON suggestions.',
  model: 'inherit',
  tools: ['Read', 'Glob', 'Skill'],
  prompt: REFACTORING_SUGGESTER_PROMPT
};
