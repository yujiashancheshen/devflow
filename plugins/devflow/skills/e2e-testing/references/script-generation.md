# Script Generation

Write the directly runnable script to `worktree/<需求名>/docs/e2e/script.js`.

## Generate

```bash
node plugins/devflow/scripts/e2e/create_case_script.js \
  --case <case.md-or-description> \
  --base-url <url>
```

`--handoff` remains a compatibility option for existing deliveries. Do not create or require a handoff in the default workflow.

The generator:

- extracts `F0-*` Case entries from Markdown into `CASE_CATALOG`;
- creates `STEP_CASE_MAP` for a single Case and leaves it explicit for a batch;
- writes `caseResults` and `stepCaseMap` into result metadata;
- embeds a Playwright loader that does not depend on manually setting `NODE_PATH`.

## Case mapping

Before running a batch script, map every executable step:

```js
const STEP_CASE_MAP = {
  'open-referral-config': ['F0-01', 'F0-02', 'F0-03'],
  'save-consumption-rule': ['F0-01'],
  'save-immediate-rule': ['F0-02'],
  'reject-duplicate-coupon': ['F0-03'],
};
```

A shared setup step may map to several Cases. A business assertion should map only to the Cases it proves. Do not claim a Case passed merely because a shared login or navigation step succeeded.

## Test flow metadata

Model a batch execution as one explicit test flow:

```js
const TEST_FLOW = {
  flowId: 'referral-mvp-f0-full',
  title: '完整测试流',
  definition: 'Case 集合 + 有序步骤 + 数据依赖 + mutation checkpoint + 断点续跑 + 每步证据 + 最终断言',
  caseIds: CASE_CATALOG.map((item) => item.caseId),
  stepKeys: resolveExecutionPlan({ mode: 'normal' }).stepKeys,
};
```

Persist the active selection under `result.testFlow`. `caseIds` define acceptance scope; `stepKeys` define the ordered execution units. Do not multiply shared steps by the number of mapped Cases. Build `stepKeys` from the steps that the selected execution plan can actually schedule. A resume-only verification stage must be recorded in the resume plan that schedules it and excluded from the normal full-flow plan.

Treat the flow as a resumable state machine:

1. `testFlow.caseIds` fixes the acceptance scope and `testFlow.stepKeys` fixes the ordered unique-step plan.
2. A step may depend on earlier data checkpoints without becoming a separate Case.
3. Persist each irreversible mutation checkpoint before any later UI assertion can fail.
4. A retry hydrates completed checkpoints, resumes the same `flowId`, and appends evidence to the same lineage.
5. Recompute mapped Case status after every retried step. A later success replaces an earlier automation failure or environment block for that Case; unrelated old Case states are not imported.
6. The final assertion derives the flow verdict from the current authoritative Case set, not from historical selected subsets.

Resolve the active step plan once per mode and reuse it everywhere:

```js
const activeStepKeys = resolveExecutionPlan({ mode, selectedCaseIds }).stepKeys;
result.testFlow.stepKeys = activeStepKeys;
ACTIVE_STEP_REPORTS = STEP_REPORTS.filter(([stepKey]) => activeStepKeys.includes(stepKey));
```

The normal full-flow plan excludes steps that only a resume-only or final-only dispatcher can schedule. A continuation keeps the normal flow plan and resumes at one failed key; it does not import a special recovery-only key into the full-flow count.

## Runtime shape

Keep these exports and result fields:

- `CASE_CATALOG`
- `STEP_CASE_MAP`
- `STEP_REPORTS`
- `CASE_CONTEXT_MAPPING.stepCaseMap`
- `result.caseResults`
- `result.stepCaseMap`
- `result.testFlow`
- `result.stepArtifacts`
- `result.steps` or completed/failed/skipped step metadata
- `stabilityGate.finalAssertion` with nonempty observable evidence for a successful run

Every successful step must capture the real visible browser surface before success is recorded:

```js
result.stepArtifacts[stepKey] = {
  status: '成功',
  screenshot: '/absolute/path/to/step-success.png',
  capturedAt: new Date().toISOString(),
};
```

For temporary H5 pages or secondary contexts, capture that page before closing it and finalize the artifact only after the step checkpoint and assertions pass. Screenshot failure makes the step non-successful because its required evidence is incomplete.

### Default video recording

Generated scripts must enable Playwright video recording by default. Accept `--record-video` as an explicit confirmation and `--no-record-video` as the user-authorized opt-out. Configure the BrowserContext with `{ dir: path.join(args.artifactDir, 'videos'), size: viewport }`, register each page immediately after creation, and finalize videos only after closing their owning context. Persist `result.videoRecording.artifacts` under `result.videoRecording = { enabled, directory, artifacts }`; use `result.stepArtifacts[stepKey].videos` when a recording belongs to a specific step. Secondary H5 contexts must be recorded independently and labeled with their page role/context so returning to the backend cannot lose evidence lineage.

Treat visible overlays as step-owned resources. After recording the relevant screenshot and checkpoint, close any generated-code dialog, success message box, drawer, popup, or temporary page and wait for the hidden/closed state before returning. This teardown is part of step completion: a leftover overlay that intercepts the next step is an automation defect, not a reason to force-click through it.

When a Case depends on an environment capability that may not be provisioned, add a read-only capability probe as a mapped step. Record the visible route, available actions, screenshot, and relevant console/network evidence. A missing capability is `阻塞`, not a product failure and not permission to bypass the UI with a direct mutation request.

For each Case result, record `expected` and `actual` when known. The report derives status from mapped steps when status is omitted.

## Playwright runtime

Generated scripts call `loadPlaywrightRuntime()` before launch. The loader searches:

1. normal local `require('playwright')`, `@playwright/test`, and `playwright-core`;
2. `E2E_PLAYWRIGHT_PATH`;
3. `NODE_PATH`;
4. ancestor `node_modules` directories;
5. `npm root -g`;
6. Homebrew/global paths, including `@playwright/cli/node_modules/playwright`.

Diagnose independently with:

```bash
node plugins/devflow/scripts/e2e/resolve_playwright.js --json
```

Use `E2E_PLAYWRIGHT_PATH=<package-dir>` only when automatic discovery cannot identify the intended installation.

## E2E integrity

- Drive business state through visible browser UI.
- Observe UI-triggered network responses only for evidence and ID correlation.
- Do not call backend APIs directly to create, update, bind, pay, publish, or issue rewards.
- Keep authentication and secrets as runtime-only inputs.
- Verify the visible authenticated identity and global business scope in an internal preflight.
- Scope interactions to the active page, drawer, dialog, or popup.
- Persist checkpoints immediately after irreversible success.
- Record observable final assertions; never weaken an expectation to make a run pass.

## Repairability

Separate preflight, mutation, checkpoint, resume, and assertion helpers inside the script. A retry after mutation must reuse the matching checkpoint and must not recreate completed irreversible stages.
