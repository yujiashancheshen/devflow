# Delivery Test Report Template

## Header

- Use the Case name as the H1, for example `F0-04 示例 Case`.
- Never put `需求交付测试报告` or an absolute path in the H1.
- Show `Case 路径：<absolute case.md path>` directly below the H1 in small muted text.
- Keep generation time and sanitization notice as secondary metadata.

## Required sections

1. `交付结论速览`
   - overall conclusion;
   - test-flow title and definition;
   - test-flow counts: selected Cases and unique ordered steps;
   - Case counts: passed, failed, blocked, not executed;
   - step counts;
   - core assertion and manual fallback count.
   - Case scope source when relevant: explicit selection or `testFlow.caseIds`.
2. `Case 执行结果`
   - one row per Case;
   - Case ID/title, status, mapped steps, expected result, actual result/failure reason.
   - mapped steps display the Chinese step title first and the raw key only as secondary code text;
   - Case ID hover and keyboard focus show title, preconditions, business steps, expected results, and actual result;
   - missing legacy fields display `未提供` and are never inferred.
3. `执行步骤与 Case 对应`
   - step name;
   - corresponding Case IDs;
   - status, measured duration, and evidence summary;
   - clickable screenshot preview for every successful step, or an explicit evidence-missing warning.
   - clickable step-scoped video links when `stepArtifacts[stepKey].videos` exists.
4. `执行录屏`
   - recording status and directory;
   - one row per video with page role, context, corresponding step, and clickable WebM path;
   - explicit `未启用录屏` note only when the user authorized `--no-record-video`.
5. `业务链路覆盖`
   - key IDs, inputs, and state transitions from result evidence.
6. `失败 / 阻塞 / 风险`
   - failed Case and step;
   - direct cause and root-cause confidence;
   - evidence, impact, recommendation, and missing evidence.
   - complete failed/blocked Case details rather than only a final summary error;
   - the mapped business-step screenshot is primary, with the final assertion screenshot only as fallback.
7. `需人工验证`
8. `源产物反查`

## Status rules

- `通过`: every required mapped step and assertion passed.
- `失败`: a mapped step/assertion failed.
- `阻塞`: execution could not reach the Case because of environment, authentication, data, or dependency conditions.
- `未执行`: not selected or no mapped step ran.
- Overall `可提测`: all selected Cases pass and final assertion evidence is nonempty.
- Overall `不可提测`: only a confirmed product defect.
- A selected set with blocked Cases and no failed Case is `执行阻塞`.
- Otherwise: `执行阻塞`.

## Style and evidence

- Use concise Chinese and tables for Case/step mapping.
- Keep test-flow, Case, and step numbers separate. Shared steps count once even when they map to several Cases.
- Case scope precedence is explicit `--case-ids`, final `testFlow.caseIds`, legacy `selectedCaseIds`, then `caseResults`; never let an old targeted subset redefine a current full flow.
- For continuation reports, provide result files in chronological order and label inherited steps with their exact source result.
- Keep local paths clickable.
- Use actual durations only; show `-` when absent.
- Do not expose full cookies, tokens, authorization values, sessions, phone numbers, personal IDs, or secret-bearing URLs.
- Do not infer success from a Toast alone; use visible final state or naturally triggered response evidence.
