# Coven 0.3.0 Testing Guide

The best way to test Coven 0.3.0 is with small, observable experiments where each capability has a clear success condition.

## Recommended test drive

### 1. Parallel research

Ask:

> Read the three implementation plans in `docs/superpowers/plans` in parallel. Compare their scope, identify contradictions, and recommend an implementation order. Do not edit anything.

**Pass criteria:**

- Multiple reads or agents run concurrently.
- Results are synthesized rather than merely concatenated.
- No files change.
- Recommendations cite specific files or sections.

### 2. Multi-agent review

Ask:

> Spawn three agents to independently review the OpenCoven Chat plans: one for architecture, one for security, and one for testability. Return one consolidated report. Do not edit files.

This tests agent delegation and role specialization. A stronger version would have one agent challenge the conclusions reached by the other two.

**Pass criteria:**

- Each agent gets a distinct assignment.
- Work runs concurrently.
- The final response resolves disagreements.
- Agents do not duplicate the same generic review.

### 3. Worktree isolation

Ask:

> Create an isolated worktree and implement one small, clearly bounded item from the chat plan. Run its tests and show me the diff. Do not merge or remove the worktree.

**Pass criteria:**

- A separate branch and directory are created.
- The main working tree remains untouched.
- Tests run inside the worktree.
- You receive a reviewable diff.
- Nothing is merged automatically.

This is particularly useful because the main tree currently has untracked `.gitignore` and `docs/` content. Isolation reduces the chance of disturbing that work.

### 4. Background tasks and monitoring

For a project with a nontrivial test suite, ask:

> Start the full test suite in the background. While it runs, inspect the implementation for likely failures. Then monitor the test process and reconcile its output with your review.

**Pass criteria:**

- The command returns control immediately.
- Other work proceeds while tests run.
- The process can be queried for status and output.
- Final reporting includes the real exit status and failures.

A harmless synthetic test is:

> Run a ten-second diagnostic process in the background, check its status before completion, and then retrieve its final output.

### 5. Built-in skills

Particularly useful skills include:

- `verify` — prove code or behavior is correct.
- `simplify` — inspect changed code and fix avoidable complexity.
- `pr-ready` — prepare a review-ready pull request.
- `debug` — enable diagnostic logging.
- `batch` — coordinate a large change across isolated agents.
- `loop` — repeat a prompt on an interval.
- `claude-api` — help build Anthropic SDK integrations.
- `remember` — promote useful persistent project knowledge.

Example lifecycle:

> Implement the requested change, run `verify`, then run `simplify`, and finally use `pr-ready` to summarize the diff and verification evidence.

**Pass criteria:**

- `verify` reports concrete commands and outputs.
- `simplify` does not refactor unrelated code.
- `pr-ready` includes context, tests, risks, and a useful PR description.

### 6. Scheduling

Ask:

> Schedule a one-shot, session-only prompt for five minutes from now that checks `git status` and summarizes anything that changed.

Or, to test recurrence:

> Every five minutes for this session, check whether the background test task has completed. Stop after it completes.

**Pass criteria:**

- The task appears in the scheduler listing.
- It runs at the expected local time.
- A one-shot task removes itself afterward.
- A session-only task does not become durable unexpectedly.

Avoid durable scheduling during the first test because it persists across sessions.

### 7. LSP intelligence

Once the repository contains application source supported by a configured language server, ask:

> Use the language server—not text search—to find the definition and references of this symbol, then report any diagnostics in its file.

**Pass criteria:**

- Definition lookup resolves semantically.
- References exclude unrelated textual matches.
- Diagnostics include file and location information.

This will be more valuable after the planned application code lands; the current repository is mostly documentation and HTML.

### 8. Structured/API output

If exercising Coven through an API, request a schema-like response:

> Review the implementation and return JSON containing `summary`, `risks`, `tests_run`, and `recommendation`. Do not include prose outside the object.

**Pass criteria:**

- Valid JSON.
- Stable field names.
- No Markdown fences or surrounding commentary.
- Tool results are represented faithfully rather than invented.

### 9. MCP and authentication

If MCP servers are configured, ask:

> List available MCP resources without modifying them. Explain what each server exposes and identify which ones require authentication.

Then test one resource read. Keep the initial test read-only and never paste tokens into chat.

## Best end-to-end evaluation

A compact but realistic trial is:

> Review the current plans using three parallel agents. Recommend one small implementation slice. Create an isolated worktree, implement only that slice, run verification in the background, simplify the resulting diff, and produce a PR-ready report. Do not merge, push, delete anything, or alter my main working tree.

That single exercise covers:

1. Parallel agents.
2. Planning and synthesis.
3. Worktree isolation.
4. File editing.
5. Background execution.
6. Verification.
7. Code-quality review.
8. PR preparation.
9. Safety boundaries.

Given the untracked planning files in the main tree, begin with the **read-only three-agent plan review**, then move to an isolated implementation after approving its recommendation.
