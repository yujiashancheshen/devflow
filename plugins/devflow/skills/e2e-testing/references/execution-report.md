# Execution And Report

## Select the script

- Use an exact user-provided script path directly.
- Otherwise search stable scripts:

```bash
node plugins/devflow/scripts/e2e/discover_js_scripts.js \
  --query "<Case IDs, title, or feature description>"
```

- If no script exists and generation is requested, create one from the Case source.
- If several state-changing scripts remain ambiguous, ask one concise question before execution.

## Execute

Inspect only the script metadata and CLI needed to build the command. Prefer explicit user inputs. Inject cookies, tokens, passwords, and storage state only at runtime and redact them in all recorded commands.

Run once in headed mode unless the user requests headless. Browser recording is enabled by default; pass `--no-record-video` only when the user explicitly opts out (`--record-video` is accepted as an explicit confirmation). Do not add external delivery state, handoff validation, certification, standalone dry-run, or standalone preflight. The script's internal preflight is part of the same execution.

Generated scripts automatically discover Playwright. If startup still reports a missing runtime, run:

```bash
node plugins/devflow/scripts/e2e/resolve_playwright.js --json
```

Only use `E2E_PLAYWRIGHT_PATH` when the resolver reports multiple ambiguous installations or none.

## Preserve evidence

Keep:

- root `result.json` for the latest run;
- prior results, logs, screenshots, checkpoints, and sanitized network evidence under `artifacts/`;
- the executed command with secrets redacted;
- Case-level `caseResults` and step mapping.
- `testFlow` metadata and one screenshot artifact for every successful step.
- video files under `artifacts/videos/` when recording is enabled, with `result.videoRecording.artifacts` and step-scoped `stepArtifacts[*].videos` persisted before report generation.

Do not overwrite a failed result before preserving it under `artifacts/`.

## Failure and bounded repair

Classify failures as:

- `automation-startup`
- `automation-assertion`
- `automation-technical`
- `environment-auth-input`
- `product-defect`
- `unknown`

For automation failures, make the smallest repair that preserves the Case expectation, scope, data strategy, and side effects. Retry at most ten times. Full rerun is allowed only before mutation; after mutation, resume from the matching checkpoint. Never replay a completed irreversible step, and do not spend another round on an unchanged failure fingerprint without new diagnostic evidence.

For a failed or blocked run, write `artifacts/failure-analysis.json` with direct cause, root-cause confidence, evidence, impact, recommendation, missing evidence, and repair history. A confirmed product defect is `不可提测`; every other nonpassable result is `执行阻塞`.

## Case status

Summarize every catalog entry:

- `通过`: all mapped required steps and the Case assertion passed.
- `失败`: a mapped step/assertion failed.
- `阻塞`: environment, authentication, data, or dependency prevented execution.
- `未执行`: not selected or no mapped step ran.

The top-level run is `可提测` only when all selected Cases pass and the final observable assertion gate passes. Preserve blocked/not-executed distinctions instead of flattening them into failures.

## Test flow status and counting

Report three independent scopes:

- test flow: one ordered run and its final verdict;
- Cases: selected acceptance units and their pass/fail/block/not-run totals;
- steps: unique execution units and their success/failure/skip/not-started totals.

Never use the number of successful steps as the number of successful Cases. Shared setup or assertion steps count once in the flow while their Case mapping remains visible.

Resolve report Case scope with this precedence:

1. explicit `--case-ids` for an intentionally targeted report;
2. final `result.testFlow.caseIds` for the current full or resumed flow;
3. legacy `selectedCaseIds`;
4. IDs present in `caseResults`.

This prevents a stale targeted selection from shrinking a later full-flow report. Titles, preconditions, business steps, and expected results come from the current script Case catalog; statuses, actual results, timestamps, checkpoints, and screenshots come from the matching result lineage.

## Generate HTML

```bash
node plugins/devflow/scripts/e2e/generate_test_report.js \
  --description "<user request>" \
  --script <script.js> \
  --command "<redacted command>" \
  --result-json <result.json> \
  [--result-json <earlier-result.json>] \
  [--case-ids F0-07,F0-12] \
  [--failure-analysis <artifacts/failure-analysis.json>]
```

For resumed or targeted batches, pass result files in chronological order and pass the exact selected Case IDs. Latest Case evidence wins; old unselected or superseded Case states must not affect the Case count or verdict.

For a resumed full flow, omit `--case-ids` only when the final result contains the correct `testFlow.caseIds`. A successful retry must replace an earlier failed/blocked status for its mapped Case before report generation. Keep the earlier result as provenance, not as the current verdict.

The default execution records browser video. Close each recorded page/context before finalizing `page.video().path()`. The generated report must include an `执行录屏` section with clickable WebM links and page role/context/step labels. If a user explicitly disables recording, report that recording was disabled rather than treating the absence of videos as a product failure.

The report must materialize every key in `testFlow.stepKeys`, even when that key is absent from `result.steps`; show it as `未开始` with no fabricated timing or evidence. A step marked `成功` or `前序成功` without a real existing screenshot is an evidence defect and forces the overall conclusion to `执行阻塞`.

The generator supports legacy single-Case results and the batch protocol:

```json
{
  "caseResults": [
    {
      "caseId": "F0-01",
      "title": "...",
      "preconditions": ["..."],
      "steps": ["..."],
      "stepKeys": ["save-config"],
      "expectedResults": ["..."],
      "actual": "..."
    }
  ],
  "stepCaseMap": {
    "save-config": ["F0-01"]
  }
}
```

The report H1 is the Case title from `case.md`; the absolute Case path appears below it in small text. The report must list passed, failed, blocked, and unexecuted Cases and show the Case IDs for every step. Keep an independent Case result table, render mapped steps with Chinese display names, and expose complete Case details through hover and keyboard focus. A failed or blocked report shows the complete affected Case and uses the mapped business-step screenshot before any final-summary screenshot. Inherited steps must link to their exact source result instead of being described as current-run execution.

The summary must include a test-flow card with its title, Case count, and unique step count. The execution-step table must include a clickable screenshot preview for every successful step. If a legacy successful step has no screenshot, render an explicit evidence-missing warning rather than silently omitting the column.

Return the local HTML link. Do not require a second completion confirmation after a successful execution.
