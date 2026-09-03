# Stable Webapp Automation Patterns

## Contents

- [Preflight and Mutation Boundary](#preflight-and-mutation-boundary)
- [Executable Stability Gates](#executable-stability-gates)
- [Component Boundaries and Fingerprints](#component-boundaries-and-fingerprints)
- [Human-like Clicks](#human-like-clicks)
- [Popper and Dropdown Discipline](#popper-and-dropdown-discipline)
- [Dialog, MessageBox, and Route Forms](#dialog-messagebox-and-route-forms)
- [Global Business Context](#global-business-context)
- [Input Values and Placeholders](#input-values-and-placeholders)
- [Exact Text Matching](#exact-text-matching)
- [Network Response Correlation](#network-response-correlation)
- [State-aware Interaction](#state-aware-interaction)
- [Error Evidence](#error-evidence)
- [Stage Timings](#stage-timings)
- [Data Strategy](#data-strategy)
- [Checkpoint and Resume](#checkpoint-and-resume)
- [Linked Fields and Async State](#linked-fields-and-async-state)
- [Assertion Strategy](#assertion-strategy)
- [Secret and Evidence Safety](#secret-and-evidence-safety)

## Preflight and Mutation Boundary

Run a read-only preflight before any state-changing stage. Verify the target environment, authentication state, visible global context, required configuration, runtime inputs, and dependent records without creating or updating data. In a normal full run, keep preflight in the same Browser/Context/Page that will perform mutation so the verified state cannot go stale between separate browser launches.

- Stop before the first mutation when preflight fails.
- Separate preflight from creation, submission, binding, payment, publishing, and other irreversible stages in `STEP_REPORTS`.
- A diagnostic dry-run validates parameters and stage order; it does not replace the same-run browser preflight when page state matters.
- Record the verified environment and context in the result JSON so a resume cannot silently switch scope.

## Runtime Stability

Keep stability requirements in the browser run itself. Before the first mutation, complete a same-run read-only preflight. It may authenticate, navigate, open read-only controls, and inspect records, but it must not create, submit, bind, pay, publish, or otherwise mutate state.

If preflight fails, stop before mutation, persist the partial result and failure evidence, and let the report generator render a failed report from those artifacts. Do not require a static validator, certification file, `--static-gate`, screenshot inspection, OCR, image recognition, or pixel validation before reporting the failure.

The schema v4 handoff is the only applicability source and must contain at least `observable-final-assertion` when script-ready. Execution contract v2 embeds its non-empty `stabilityRules` unchanged and initializes every runtime entry as `active`. Call `recordStabilityRule(ctx, id, outcome)` only inside an active `runStep` callback with a live Playwright page and no later than the rule cutoff. `applied` requires `verified: true` and a non-empty observable `observation`. `expired` requires an observable mismatch and a replacement containing `rule`, `status: applied`, `verified: true`, and a non-empty replacement observation. Runtime stamps stage and time. Missing evidence, a missing replacement, source-only speculation, prior script success, inconvenience, or a pre-execution assumption leaves the rule unresolved and blocks the relevant mutation stage.

Runtime tooling cannot infer business mutation semantics from an arbitrary click or HTTP method. Case authors must put every state-changing action in a mutation stage; preflight and read-only stages may still use clicks or POST requests that are semantically read-only.

Keep `--dry-run` for parameter/contract diagnosis and `--preflight-only` for environment, authentication, permission, global-context, or page-entry diagnosis. They are not default prerequisites for every generation or daily execution; the full script's same-run runtime preflight remains part of normal execution.

The embedded `E2E_EXECUTION_CONTRACT` is case data expressed through generic stage modes. Keep case routes, labels, selectors, IDs, and expected business values in the generated script or Case, never in the validator.

Runtime `runStep` still enforces checkpoint and assertion-evidence requirements for stages that declare them. These runtime checks are execution behavior, not a separate report-generation gate.

## Component Boundaries and Fingerprints

- Use `Case orchestration -> business component -> page/UI component -> shared/runtime`; reject cycles and reverse imports.
- Components share the caller's `page/context` and explicit artifact context. They do not launch browsers or own the Case-wide final result.
- Keep fixed test data, secrets, environment defaults, Case-only assertions, and checkpoints out of shared components.
- Keep component dependencies explicit so case authors can review the impact of a shared component change before rerunning a state-changing flow.

## Human-like Clicks

Automation should click the same visible area a person clicks:

- Select input: click the visible wrapper or suffix area, not a hidden/readonly input.
- Cascader/menu item: click the row center, not nested label text if the row owns the pointer event.
- Button: click the visible button center after confirming it is enabled and visible.

Use a center-click helper when component internals intercept pointer events:

```js
async function clickLocatorCenter(locator, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 10_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for ${options.name ?? 'locator'}`);
  await locator.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
```

## Popper and Dropdown Discipline

Many UI libraries teleport dropdowns to a global container. Old poppers can remain in DOM and confuse later locators.

- Always query visible poppers only.
- Prefer the last visible popper when one click just opened a dropdown.
- After selecting a value, wait until that popper closes or press `Escape` and verify it is gone.
- If an option is not found, print visible options from the current popper.
- For date/time pickers inside dialogs, do not blindly press `Escape` after selecting a date. It can close the parent dialog. Prefer clicking the picker confirm button, then verify both the picker closed and the parent dialog is still visible.

## Dialog, MessageBox, and Route Forms

Component libraries often use different containers for flows that look similar to a user:

- Element Plus `ElDialog`: `.el-dialog`.
- Element Plus `ElMessageBox.confirm`: `.el-message-box`, not `.el-dialog`.
- Routed create/edit pages: a page container such as `.class-creation-container`, not a modal.
- Shared custom modals: app-specific wrappers such as `.store-modal`.

After a click like "新建", inspect the rendered DOM or source before choosing the wait target. Scope later locators to the current visible container. For duplicate titles such as breadcrumb "新建商品" and page title "新建商品", avoid page-wide strict text locators; wait for a scoped title or form container.

A visible popup that is not the target business container is not itself a business failure. Identify whether the target is a dialog, message box, drawer, route form, or other current visible owner, then classify failure from the target state and evidence.

Do not check for a drawer or dialog only once after a click. UI animations and async data can make the container appear a few hundred milliseconds later. Use a helper that polls for the latest visible matching container before failing.

## Global Business Context

Admin apps often have a global business scope in the shell. Search pages and downstream APIs may use that scope even when a form also contains a local scope field.

- After each route navigation, set and verify the global context before interacting with the page.
- Prefer a shared helper such as `ensureSchool(ctx)` that reads available context from auth/session data, updates the visible dropdown or storage, then reloads or waits for the page to settle.
- Record the selected context in the result JSON.
- If a search unexpectedly returns zero rows for a freshly created entity, inspect the page shell context before changing selectors.

Treat authentication inputs as different state carriers:

- An empty or omitted Cookie means only that Cookie injection did not occur. It does not prove that the current browser identity expired; verify the visible authenticated identity and current shell context independently.
- A runtime cookie may restore identity without restoring local storage, selected school, tenant, or campus.
- A Playwright storage state may restore cookies and origin storage, so a previous run can appear stable only because the target context was already selected.
- Validate visible shell context and persisted context independently after navigation. Do not use a successful storage-state run as proof that a cookie-only run can skip context selection.

## Input Values and Placeholders

Do not use `document.body.innerText` or `getBodyText()` to assert values that live inside form controls:

- `input.value` is not body text, including disabled Element Plus inputs.
- `placeholder` is an attribute, not body text.
- Select tags/chips can appear in wrapper text, but native input values usually do not.

Use locator assertions against the control itself:

```js
await page.locator('input[placeholder="Enter reference ID"]:visible').first()
  .waitFor({ state: 'visible', timeout: 20_000 });

const values = await section.locator('input:not([type="hidden"]), textarea')
  .evaluateAll((nodes) => nodes.map((node) => node.value || node.getAttribute('value') || '').filter(Boolean));
if (!values.includes(expectedValue)) throw new Error(`Value not found: ${expectedValue}`);
```

## Exact Text Matching

Short labels often overlap. `高意向` and `意向`, or `数学` and `数学班`, should not be matched with loose text.

```js
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactLabelPattern(label) {
  return new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`);
}
```

Use exact patterns in option-row filters:

```js
const option = popper.locator('.el-select-dropdown__item')
  .filter({ hasText: exactLabelPattern(label) })
  .first();
```

## Network Response Correlation

Pages often issue several requests to the same endpoint. Match UI-triggered responses with all stable evidence available:

- URL and HTTP method.
- Request query or body fields tied to the current action.
- Stable identifiers or the exact search keyword used by the UI.
- The response shape and business success fields expected for that stage.

Create the response wait before triggering the UI action. Do not accept the first URL match when concurrent requests can satisfy it. Record the sanitized request correlation and response used by each irreversible stage.

For failure evidence, persist only `xhr` and `fetch` request, response, and request-failed events to `network-events.ndjson`. Cap persisted request and response bodies at `65536` bytes. Apply the structural redaction rules in [Secret and Evidence Safety](#secret-and-evidence-safety) before persistence. Only the Playwright response header `x-trace-id` and the response event/candidate fields derived from that header may preserve the exact value.

## State-aware Interaction

Read the current state before operating stateful controls or records:

- Check a checkbox, radio, toggle, expansion panel, or selected row before clicking; do not invert an already-correct state.
- After typing or selecting, read the control value or visible selected state again. A click that did not throw is not proof the value changed.
- Locate list records by a stable identifier and require exactly one match before acting. Zero or multiple matches stop the stage.
- If the page already shows the expected bound, submitted, paid, published, or otherwise completed state, recover its identifiers and resume instead of replaying the action.

## Error Evidence

Every generated script should produce enough evidence to tell whether the failure is automation or business state:

- current stage name
- target field and option
- visible options when selection fails
- screenshot path
- result JSON with partial IDs and generated test data
- page URL and title if navigation is involved
- raw response JSON for save/publish/shelf APIs
- business error messages such as time-slot validation failures

When an API response reports non-success (`errNo !== 0`, `code !== 0`, `success === false`), write the response to artifacts and throw that business error immediately. Do not wait for navigation or a toast if the backend has already rejected the operation.

Select at most three failure candidates explicitly related to the failed step. Prioritize explicit step correlation, business failures, HTTP `4xx/5xx`, and `requestfailed` events. Do not select an ordinary request merely because it is temporally near the failure when reliable correlation is unavailable.

Known transient backend rejections, such as duplicate-click or rate-limit messages, can be retried only when retrying is safe. If an irreversible upstream action already succeeded, record its ID and resume from that ID instead of creating the entity again.

When the same failure fingerprint repeats at the same read-only stage, compare authentication mode, visible global context, URL, screenshot, and popup timing before rerunning unchanged. A read-only preflight failure does not consume generated business data; increment fresh data only after an irreversible action is observed or its success is recorded.

## Stage Timings

Record `startedAt`, `finishedAt`, `durationMs`, and `status` for every executed stage in `result.stepTimings`. Use the same stage keys as `STEP_REPORTS`; mark resume-only stages as `跳过` without inventing a duration. Keep whole-run `startedAt` and `finishedAt` for backward compatibility.

## Data Strategy

Avoid brittle fixed business data when possible:

- Generate fresh phone/account data per run.
- Select available business entities dynamically, such as classes with remaining seats.
- If a fixed entity is required and unavailable, fail with a business-state error like `class sold out`, not a generic click error.
- Write partial result JSON after each irreversible business action.
- For same-day scheduling, never assume the first visible time slot is valid. Pick a slot whose start time is safely in the future, or use a valid custom slot if the UI allows it.
- For table rows containing names with dates/random digits, do not use the first number as the entity ID. Prefer response payload IDs, stable columns, or a known neighboring ID to extract the correct value.
- For long irreversible flows, add resume flags such as `--skip-create` so later steps can be debugged against existing data without creating duplicates.

## Checkpoint and Resume

Persist checkpoint data immediately after every irreversible response succeeds, before optional UI waits or downstream assertions.

Keep checkpoint/resume self-contained in the business script and its artifact directory. Do not delegate per-stage replay safety to `manage_delivery_state.js` or another Codex task-state process, and do not embed a workspace or thread-specific orchestration command in generated code. The outer delivery agent may track overall progress, but the script must remain directly executable with only its declared inputs.

- Save the stage key, stable identifiers, selected data offset, context, and completion timestamp needed to recover the action.
- Preserve partial result JSON even when a later assertion fails.
- On resume, validate the checkpoint belongs to the same case, environment, and global context.
- Recover existing records from checkpoint and read-only UI queries before opening a create form.
- Recreate data only when absence is proven and repeating the action is safe.
- A skipped stage must reference checkpoint or prior-result evidence; never report it as newly executed.

## Linked Fields and Async State

Some form fields reset each other. For example, selecting subject can clear grade, or selecting school can refresh the available campus list.

- Choose the order based on actual page behavior, not field order in the case document.
- When an upstream action can auto-populate downstream select or cascader fields, prefer preserving the visible populated value instead of re-selecting it mechanically.
- For linked dropdowns, fill only fields that are empty or visibly wrong. Re-selecting an already populated value can trigger async linkage and clear another inferred value.
- When preserving a populated default, consider recording the field label and value in the result JSON so a headed rerun explains why the script skipped that dropdown.
- After selecting a linked field, confirm the visible form item still contains the intended value.
- When a cascader requires a leaf node, selecting only the parent is incomplete. Read back the final visible selected path/value and require the leaf; preserve a valid auto-populated downstream value rather than resetting it mechanically.
- Before submitting, assert required field values locally so a missing selection fails with a precise field error rather than a generic "API response not observed" timeout.

Business state changes can be asynchronous after a successful UI action. For assertions on a downstream state transition, search by stable IDs and poll the visible list or naturally triggered UI response a bounded number of times before failing.

## Assertion Strategy

Assert observable invariants rather than incidental implementation details:

- Capture the relevant baseline before the action, then verify the final state and expected delta.
- Persist the observed assertion through `recordAssertionEvidence(ctx, stageKey, evidence)` so the report can distinguish an executed assertion from a contract declaration.
- Combine visible UI state with the response naturally triggered by the UI when both exist.
- Treat undocumented enum values as diagnostic data, not a pass/fail oracle. Prefer documented success fields, explicit failure reasons, and observable final state.
- Use stable identifiers to prove that the final record is the one created or selected earlier in the flow.
- Bound asynchronous polling by attempts or a total deadline and report the last observed state on failure.

## Secret and Evidence Safety

Inject cookies, tokens, passwords, authorization headers, and raw storage state only at runtime.

- Do not persist secret values in cases, script defaults, command examples, logs, result JSON, checkpoints, failure analysis, screenshots, or reports.
- Store generated personal or account data only when recovery requires it; mask it in console output and reports.
- Mask visible inputs, identity fields, and stable personal identifiers in screenshots while keeping the business outcome inspectable.
- Structurally redact captured request and response events case-insensitively before writing artifacts, including `network-events.ndjson`. Header names remain, but values for `Cookie`, `Set-Cookie`, `Authorization`, `token`, `session`, `password`, and equivalent secret keys become `***`.
- Query, JSON, Form, and nested request/response structures are recursively key-redacted before persistence: values under `Cookie`, `Set-Cookie`, `Authorization`, `token`, `session`, `password`, and equivalent secret keys become `***`. Phone/identity values are masked wherever they occur in retained strings or structures.
- Request headers, URL query fields, request bodies, and response bodies named `x-trace-id` remain sensitive and must be redacted. Preserve the exact `x-trace-id` only when Playwright supplies it as a response header, and only copy that exact value into its derived response event and failure-candidate fields.
- Preserve only structurally redacted bodies up to `65536` bytes and the trusted `x-trace-id` response-header value.
- Run an explicit secret scan across text artifacts before delivery.
