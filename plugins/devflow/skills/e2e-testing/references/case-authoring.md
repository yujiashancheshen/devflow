# Case Authoring

Normalize all inputs into a Case catalog. Do not create a handoff in the default workflow.

## Source handling

- Treat PRD, design, prototype notes, and attached Markdown as evidence only.
- For Markdown headings such as `#### F0-01 title`, run:

```bash
node plugins/devflow/scripts/e2e/extract_markdown_cases.js \
  --input <source.md> --prefix F0 --json
```

- Preserve the original Case ID, title, covered requirement, preconditions, ordered steps, and expected results.
- Ignore requirement prose, appendices, and nonmatching headings as executable Cases.
- For a direct single Case, create one catalog entry.
- For a feature description, split only at independently assertable outcomes. Avoid one Case per click or one oversized Case for unrelated outcomes.

## Minimal `case.md`

Use `assets/detailed-case-template.md`. A Case file may contain one or many Cases and must include:

- source and scope;
- environment and runtime inputs, naming secrets without recording their values;
- Case catalog with stable IDs;
- preconditions;
- ordered UI steps;
- expected visible results;
- final assertion;
- side effects and safe rerun rule when applicable.

Do not require source-code graphs, page evidence trees, reuse audits, or a structured handoff before script generation. Inspect source or the live page only where it resolves a real ambiguity in navigation, selectors, data mapping, or expected behavior.

## Batch rules

For every Case, decide whether it is:

- independently executable;
- dependent on another Case's data;
- destructive or irreversible;
- safe to rerun from the beginning;
- resumable only from a checkpoint.

Keep these dependencies explicit so the script can distinguish `失败`, `阻塞`, and `未执行`.

## Ready condition

A Case is script-ready when its entry, inputs, actions, expected result, and final assertion are clear enough to implement without guessing. Ask only for missing values that materially change scope, side effects, or success criteria. Runtime data with a deterministic generation strategy does not block authoring.
