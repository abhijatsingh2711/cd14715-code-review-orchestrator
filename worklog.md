
## Session Log — 2026-10-28: bring-up, debugging, formal runs

### Fixes applied
1. **Structured-output suppression (Agent SDK 0.1.77)**: with `outputFormat: { type: 'json_schema' }` set, the orchestrator emitted a valid-but-empty report and never called tools. Removed `outputFormat` from `runQuery()`; reports are parsed from the result text via `parseJsonCandidate()` (fence/brace tolerant). Updated `tests/orchestrator.test.ts` to match.
2. **MCP parameter casing**: prompt used camelCase `pullNumber`; the GitHub MCP server requires snake_case `pull_number`. Fixed in `src/prompts/orchestrator.prompt.ts`.
3. **Absolute-path Write failure**: on PR #3 the model wrote fetched sources to `/review-workspace/...` (filesystem root) causing `EACCES: permission denied`. Hardened the prompt to mandate relative paths (`review-workspace/pr-N/...`) and forbid absolute paths.

### Formal run results (udacity/cd14715-simple-todo-app)
| PR | File | Score | Critical | Test gaps | Refactors | Duration |
|----|------|-------|----------|-----------|-----------|----------|
| 1 | fixtures/clean-code.ts | 78/100 | 0 | 6 | 4 | 115s |
| 2 | src/todo.ts | 28/100 | 3 | 6 | 5 | 130s |
| 3 | src/premium.ts | 42/100 | 4 | 4 | 5 | 118s |

9/9 deliverable reports in reports/ (JSON + MD + HTML per PR). Smoke run on octocat/Hello-World PR #1 is legitimately empty (README-only PR filtered by the JS/TS analysis-set rule); both MCP tool calls verified in the SDK transcript.

### Hygiene
- Debug artifacts removed (probe-mcp.ts, api_test*.json, lint/test/smoke logs).
- `.env` confirmed git-ignored; GitHub PAT to be revoked after final runs.
- `npm run lint` EXIT 0; `npx vitest run` EXIT 0 (23/23) after all patches.
