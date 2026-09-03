# 阶段交接契约

## 目录

- [持久化任务状态](#持久化任务状态)
- [使用方式](#使用方式)
- [请求到模式](#请求到模式)
- [历史参考策略](#历史参考策略)
- [公共内容边界](#公共内容边界)
- [Case 到脚本](#case-到脚本)
- [前端组件与页面结构契约](#前端组件与页面结构契约)
- [自动化模块契约](#自动化模块契约)
- [脚本生成到首次运行](#脚本生成到首次运行)
- [执行到报告](#执行到报告)
- [失败与修复边界](#失败与修复边界)
- [秘密与脱敏](#秘密与脱敏)

## 持久化任务状态

除业务交接物外，每次完整交付必须维护：

```text
<workspace>/e2e-delivery/.state/threads/<task-id>.json
<workspace>/worktree/<需求名>/docs/e2e/delivery-state.json
```

任务索引按当前任务或会话身份隔离并保留完成墓碑；身份优先取显式 `--thread-id`，再由当前运行时会话提供。`workspace` 必须先规范化为存在目录的 `realpath`；`caseId` 必须是单个安全目录段，`runRoot` 必须严格等于 `path.join(workspaceRealpath, 'e2e-delivery', 'cases', caseId)`。从 workspace 到 runRoot 的现存路径段不得是 symlink；相对路径、路径穿越、其他 Case 或工作区外目录都拒绝。`delivery-state.json` 是上下文压缩、恢复、插话和工具中断后的唯一进度入口，至少记录 `threadId`、`requestKey`、`caseId`、`mode`、`runRoot`、`phase`、`status`、`nextAction`、`browser`、`policy`、`approval`、`userConfirmation`、`artifacts`、`sideEffects`、`actions` 和 `phaseHistory`。最终完成时，`userConfirmation` 记录明确确认的布尔值和时间；未确认不得写入完成墓碑。

`.state/threads/` 是状态管理器必需的内部运行时目录，不属于业务交付产物；`.state/`、`threads/` 路径段必须是工作区内的真实目录，任务索引必须是规范位置的普通文件，任何 symlink 都拒绝且不得写出工作区。完整目录校验以结构白名单扫描整个真实 `e2e-delivery/` 树：根级只允许 `.state/`、`cases/`、`components/`；Case 根级只允许固定交付文件和 `artifacts/`，根级或其他位置的 `artifacts/` 非法。扫描跳过根级 `.state/` 与合法 Case 内的 `artifacts/` 内容，不会跟随 symlink；`cases/`、`components/`、Case 与合法 `artifacts/` 必须是非 symlink 目录，固定 Case 文件必须是普通非 symlink 文件。

恢复时先运行 `manage_delivery_state.js resume`。只有 `recoveryGate: continue` 才能执行 `nextAction`；`stop` 必须停止。禁止重新读取需求、重新探测、重新生成骨架或新建交付目录。状态文件和磁盘产物优先于对话摘要。

整个任务或会话的 `browser.caseProbeTool` 和 `browser.scriptProbeTool` 必须为严格有头 `playwright-cli`；`browser.scriptRuntime` 必须为 `playwright-js`，只用于生成脚本内部预检、业务执行和断言。禁止使用 `playwright-js` 临时探测，禁止切换到 `agent-browser`、应用内 Browser 或其他交互浏览器工具。`case-probe` 与 `script-probe` 动作开始前都必须存在对应的 headed binding。

页面探测必须作为 `kind: probe` 动作在打开浏览器前写入 `actions`，并传入影响渲染的非秘密 `renderContext`。完成时记录稳定 `pageEvidence` 路径；恢复后只有 subject、源码指纹和渲染上下文指纹都相同的已完成动作才能跳过，中断或不确定动作只核对持久化证据，不自动重跑。运行时外层直接控制的不可逆动作可使用 `kind: mutation`；完整 Playwright 脚本内部不得调用 `manage_delivery_state.js` 或 `begin-action/finish-action`。脚本内的逐阶段防重放以 checkpoint/resume 和当前 UI 状态为准。

`policy.superpowersDisabled` 和 `policy.singleBrowserTool` 必须为 `true`，新状态同时记录 `policy.scope: "delivery-run"`。这项禁用从业务交付 `init` 生效，到 `pause`、`blocked` 或 `complete` 结束；维护、修改和校验本 Skill 本身不在禁用范围内。

`init` 必须记录七种模式之一：`full`、`case-only`、`prd-to-script`、`script-only`、`execute-existing`、`report-only`、`safe-rerun`。状态管理器按模式执行合法阶段图；`page-probe` 是按需阶段，其余模式必经门禁不能跳过。`prd-to-script`/`script-only` 只能以 `prepared` 结束；`case-only` 只能以 `artifact-ready` 结束并返回 `case-ready`，`report-only` 只能以 `artifact-ready` 结束并返回 `report-ready`。这些非执行终态的 `recoveryGate` 都是 `stop`，不得 pause、不得接收最终用户确认或写入 `completed`；unpause 只允许精确恢复暂停前的 `active` 或 `blocked`。只有 `full`、`execute-existing`、`safe-rerun` 能创建完成墓碑。用 `promote-prepared --mode full|execute-existing|safe-rerun` 进入完整执行。用户确认执行后，把当前 Case 固定路径的 `handoff.json` 中 `executionApproved` 写为 `true` 并重新校验，再用 `approve-execution` 将审批绑定到该文件 SHA-256；外部文件、其他 Case 和 symlink 都拒绝，任何 handoff 修改都会使 mutation 门禁失效。`blocked` 只能用带原因和下一动作的 `unblock` 恢复到阻塞前阶段。

## 使用方式

阶段之间通过事实文件交接，禁止依赖同一对话中的隐式记忆：

- 详细 Case：`worktree/<需求名>/docs/e2e/case.md`
- 结构化上下文：`worktree/<需求名>/docs/e2e/handoff.json`
- 业务脚本：`worktree/<需求名>/docs/e2e/script.js`
- 执行结果与报告：`worktree/<需求名>/docs/e2e/result.json`、`report.html`
- 状态与证据：`worktree/<需求名>/docs/e2e/delivery-state.json`、`artifacts/`
- 公共自动化模块：`e2e-delivery/components/`
- 重复维护覆盖稳定的 `result.json` 和 `report.html`；checkpoint、截图和网络日志保存在 `artifacts/`

状态中的 known artifacts 必须逐项等于当前 Case 的固定路径：`worktree/<需求名>/docs/e2e/case.md`、`worktree/<需求名>/docs/e2e/handoff.json`、`worktree/<需求名>/docs/e2e/script.js`、`worktree/<需求名>/docs/e2e/result.json`、`worktree/<需求名>/docs/e2e/report.html`。读取或完成门禁必须用 `lstat` 确认它们是普通文件而非 symlink，并确认 `realpath` 仍是该固定路径。`complete --result-json/--report` 同样只能使用后两者，不能引用其他 Case 或工作区外文件。

缺少必填项时回到上游补齐，不使用猜测值继续。对话上下文可以帮助定位文件，但不能替代 handoff 文件。

## 请求到模式

| 用户意图 | 模式 | 首个本地阶段参考 |
| --- | --- | --- |
| 从 PRD 或简版用例完成全链路交付 | `full` | `references/case-authoring.md` |
| 只生成详细 Case | `case-only` | `references/case-authoring.md` |
| 从 PRD/简版用例生成脚本但拆开执行 | `prd-to-script` | `references/case-authoring.md` |
| 根据已确认 Case 生成脚本 | `script-only` | `references/script-generation.md` |
| 执行已有脚本并出报告 | `execute-existing` | `references/execution-report.md` |
| 根据已有结果重建报告 | `report-only` | `references/execution-report.md` |
| 替换运行输入或断点安全重跑 | `safe-rerun` | `references/execution-report.md` |

用户明确指定的模式优先。存在多个候选脚本且错误选择可能改变业务数据时，必须先询问。

## 历史参考策略

`historyPolicy` 只能使用以下值：

| 值 | 语义 |
| --- | --- |
| `reference` | 默认。发现并评估历史业务脚本、结果、checkpoint 和共享组件 |
| `ignore-business-scripts` | 用户明确要求不依赖历史业务脚本；仍可使用已有运行证据的共享组件 |
| `isolated` | 用户明确要求完全独立；不读取历史业务脚本、结果或共享组件 |

`reference` 不是复制全部历史代码。候选优先级为：有成功最终断言和通过结果、存在成功 checkpoint、仅有失败但能提供页面/选择器证据、无运行证据的代码。handoff 必须记录 `historyReferences.selected` 与 `historyReferences.rejected` 及理由，并记录 `reuseAudit`：搜索是否完成、候选引用、采用/拒绝决定和理由。`reuseAudit.policy` 必须与顶层 `historyPolicy` 一致；选中的自动化模块必须能追溯到候选引用或明确标记为本次新建。

历史产物中以下内容永不复用：秘密值、Case 专属运行输入或业务标识、旧 checkpoint 的上下文、旧环境默认值、未经当前 PRD/源码/页面证据验证的业务结论。

## 公共内容边界

本 Skill 目录只保存跨产品成立的阶段、契约和结构性反例。具体 Case 的路由、角色、文案、选择器、业务实体、业务 ID、个人标识、数据值以及数据生成或替换策略只能存在于该次交付产物中，不得写入 `SKILL.md`、本契约、`agents/openai.yaml` 或测试夹具。示例和测试使用 `example-*`、`sample-*`、`resource-*` 等中性命名，秘密检测使用显式占位值。

维护后运行：

```bash
node plugins/devflow/scripts/e2e/validate_skill_content.js \
  --skill plugins/devflow/skills/e2e-testing
```

## Case 到脚本

Case 阶段必须在 `worktree/<需求名>/docs/e2e/case.md` 同目录写入 `handoff.json`。以下是未就绪的结构草稿，不得直接用于脚本生成或执行；将 `caseReady/scriptReady` 改为 `true` 前，必须填充下述必需证据并通过校验器：

```json
{
  "schemaVersion": 4,
  "caseId": "CASE-ID",
  "casePath": "/absolute/path/to/case.md",
  "caseReady": false,
  "scriptReady": false,
  "historyPolicy": "reference",
  "environment": {},
  "businessContext": {},
  "runtimeInputs": [],
  "secretInputNames": [],
  "routes": [],
  "uiNodes": [],
  "selectors": [],
  "uiTriggeredEndpoints": [],
  "sourceEvidence": [],
  "frontendComponents": [],
  "pageStructures": [],
  "pageEvidence": [],
  "probeCoverage": {
    "status": "incomplete",
    "requirements": [],
    "gaps": ["complete-real-page-evidence"]
  },
  "historyReferences": { "selected": [], "rejected": [] },
  "reuseAudit": {
    "policy": "reference",
    "searched": false,
    "candidates": [],
    "decision": "pending",
    "reason": ""
  },
  "automationModules": [],
  "sideEffects": [],
  "assertions": [],
  "stabilityRules": [],
  "recovery": {},
  "unresolvedItems": [{ "id": "complete-evidence-contract" }],
  "executionApproved": false
}
```

`runtimeInputs` 每项只记录 `name`、`type`、`source` 和注入/生成方式，不得包含 `value`、`default` 或 `defaultValue`；秘密只以参数名列在 `secretInputNames`。`automationModules` 中每项至少包含 `id`、`path`、`exports` 和 `selectionReason`。`reuseAudit.candidates` 每项至少包含 `ref`、`kind`、`decision` 和 `reason`，并且 `searched=true`；复用模块时每个模块路径必须能追溯到 `decision=selected/adopted` 的候选。路径相对 handoff 所在目录或使用绝对路径。进入脚本生成前执行：

```bash
node plugins/devflow/scripts/e2e/validate_handoff.js \
  --handoff <handoff.json>
```

校验器输出报告使用 `schemaVersion: 1`，并用 `handoffSchemaVersion` 单独记录被校验 handoff 的版本；当前可通过的 handoff 契约版本仍为 `4`。

Case 关键项、脚本关键项或页面探测覆盖未解决时，`caseReady` 或 `scriptReady` 必须为 `false`，`unresolvedItems`/`probeCoverage.gaps` 必须列出问题；不得生成半成品业务脚本。`probeCoverage` 最低字段为 `status/requirements/gaps`；每个 requirement 最低字段为 `id/status/evidenceRefs`。`scriptReady: true` 时，`probeCoverage.status` 必须是 `complete`，所有 requirement 必须是 `observed` 且引用当前 `pageEvidence`，`gaps` 必须为空；同时 `routes`、`uiNodes`、`sourceEvidence`、`frontendComponents`、`pageStructures`、`pageEvidence`、`assertions` 和 `stabilityRules` 必须非空。源码和历史实现只能指引下一项探测，不能替代 `pageEvidence` 猜测选择器、交互路径、容器、选项或数据映射。核心条目最低字段为：route=`id/path`，uiNode=`id/label/kind/frontendComponentId`，selector=`id/kind/value`，UI endpoint=`id/method/urlPattern`，source evidence=`id/type/ref/summary`，side effect=`stage/description`，assertion=`stage/expected/evidenceSource`，recovery=`strategy`。`executionApproved: false` 不阻塞仅 Case 或仅脚本模式，但任何探测副作用仍须在动作开始前明确声明并具备恢复策略。

`stabilityRules` 是本 Case 唯一的适用规则清单。必须根据当前 PRD、源码和页面证据逐项判定适用性；不适用的规则不写入清单，也不得标记为 `expired`。每项最低字段为 `id/category/requiredBefore/reason/sourceRefs/evidenceRefs`，`id` 等于稳定通用 `category`，`requiredBefore` 只能是 `mutation` 或 `certification`，证据引用必须指向当前 `sourceEvidence/pageEvidence`。其中 `certification` 是兼容字段名，仅表示最终断言前的运行时证据截止点，不触发独立认证文件、静态门禁或认证命令。通用类别固定为：`authentication-state`、`global-business-context`、`visible-owner-interaction`、`teleported-popup-scope`、`business-container-scope`、`exact-option-match`、`linked-field-completion`、`response-correlation`、`mutation-checkpoint-resume`、`observable-final-assertion`。

运行时所有适用规则从 `active` 开始，只能在持有 live Playwright page 的活动 `runStep` callback 内记录。`applied` 必须带 `verified: true` 和非空可观察 `observation`；`expired` 必须带执行时可观察 mismatch，并同时记录 replacement 规则、`status: applied`、`verified: true` 和非空替代观察。运行时统一写入 stage 和时间，调用方不得自证。意见、不便、旧脚本成功、源码推测、执行前假设都不能证明失效。缺证据、缺 replacement 或仍为 `active` 时，按 `requiredBefore` 阻断首次 mutation 或最终成功结果。

## 前端组件与页面结构契约

本契约中的“前端组件”使用产品前端工程的定义：它是当前源码中可独立识别、拥有明确 `sourcePath`、框架标识和组件名，并负责一个可识别渲染边界的组件声明。组件可以来自任意前端框架；路由页、布局、抽屉、对话框、表单、Tab 面板和业务 Widget 都可以是前端组件。

以下对象不是前端组件：

- 路由或 URL。
- 单个 DOM 元素、按钮、输入框、文案或 CSS 选择器。
- 为 Case 临时划分的一段操作步骤或页面区域。
- Playwright helper、Page Object、业务动作封装或 shared/runtime 模块；这些统一称为 `automationModules`。

`frontendComponents` 记录源码组件图。每项最低结构为：

```json
{
  "id": "example-dialog",
  "framework": "svelte",
  "name": "ExampleDialog",
  "kind": "dialog",
  "sourcePath": "/absolute/path/ExampleDialog.svelte",
  "sourceSha256": "<sha256>",
  "routeIds": ["sample-route"],
  "childIds": ["example-form"]
}
```

同一源码组件被多个路由复用时仍只有一个组件 `id`，把所有上下文写入 `routeIds`。`childIds` 表示源码直接渲染的前端子组件；不要把 DOM 节点或自动化模块放入该数组。

`pageStructures` 记录页面探测得到的组件级浏览器结构。一个条目对应“前端组件 + 渲染变体 + 当前源码指纹 + 渲染上下文指纹”，最低结构为：

```json
{
  "id": "example-dialog-open",
  "frontendComponentId": "example-dialog",
  "renderVariant": "open",
  "probeSubjectKey": "frontend-component:example-dialog|variant:open",
  "sourceFingerprint": "<same-as-sourceSha256>",
  "renderContext": {
    "routeIds": ["sample-route"],
    "role": "sample-role-a",
    "scopeRef": "sample-scope-a",
    "featureFlags": [],
    "dataState": "empty"
  },
  "renderContextFingerprint": "<sha256-of-canonical-render-context-json>",
  "observedRouteIds": ["sample-route"],
  "containerKind": "dialog",
  "visibleAnchors": ["Example form"],
  "uiNodeIds": ["example-form"],
  "childComponentIds": ["example-form"],
  "structure": [
    { "kind": "heading", "label": "Example form" },
    {
      "kind": "form",
      "uiNodeId": "example-form",
      "children": [
        { "kind": "frontend-component", "frontendComponentId": "example-form" }
      ]
    }
  ],
  "evidenceRefs": ["evidence-example-dialog"],
  "observedAt": "<ISO-8601-time>"
}
```

`structure` 是浏览器可见结构树，记录对后续 Case/脚本有用的容器、标题、区域、表单、表格、动作节点和前端子组件关系。它不是完整 DOM dump，但不得为空或只保留一句结论。`pageEvidence` 通过 `pageStructureId` 关联 observation、截图或脱敏网络证据。

页面探测允许执行为获取完整真实证据所必需的 UI 副作用。`probe` 与 `script-probe` 都必须在 `begin-action` 时通过 `sideEffects.plannedStages/impact/recoveryStrategy` 声明可能阶段、影响与恢复策略；每个成功副作用立即保存 ID、页面状态和 checkpoint/result，`finish-action` 的 `completedStages` 只能是已声明阶段。中断时核对现有状态，不换 action key、不重放。

探测去重键使用 `probeSubjectKey + sourceFingerprint + renderContextFingerprint`。`renderContext` 至少覆盖所有已知会影响渲染的路由、角色、租户或业务作用域引用、功能开关以及数据状态分类；不同上下文不得合并。状态管理器和 handoff 校验器都基于按键名排序的规范化 JSON 计算 SHA-256。`renderContext` 不得包含 Cookie、Token、Authorization、密码、session 或 storage state。只有三个指纹维度都相同才允许复用；任一维度变化都形成新的探测身份。完成 `probe` 动作时必须持久化 `pageStructure` 或 `pageEvidence` 路径。

## 自动化模块契约

新脚本使用以下目录职责：

```text
e2e-delivery/
  cases/<case-id>/script.js
  components/<domain>/
  components/shared/
```

- `shared/`：运行时、网络证据、通用可见元素操作、checkpoint 等无业务语义能力。
- `components/<domain>/`：可复用业务页面操作或业务动作，只通过 UI 操作。
- `cases/`：参数解析、阶段编排、Case 特有断言和报告映射。

自动化模块不是独立 CLI。它接收同一个 `page/context`、显式参数和产物上下文，不自行启动浏览器；不内置 Case 特有运行输入、业务标识、环境、秘密、最终结论或跨 Case checkpoint。依赖方向固定为 `Case -> 业务动作模块 -> 页面/UI 操作模块 -> shared/runtime`，禁止循环引用。

## 脚本生成到首次运行

脚本生成器默认消费 handoff，而不是重新广搜全部 PRD、源码和页面。只有 handoff 缺失、证据冲突或实现所需字段不存在时才定向补证，并将补充证据回写 handoff。`reuseAudit.searched=true` 是脚本生成前的硬门禁。

生成命令：

```bash
node plugins/devflow/scripts/e2e/create_case_script.js \
  --case <case.md> \
  --handoff <handoff.json> \
  --base-url <default-host>
```

`full` 的首次生成或脚本修复完成后由路由进入执行/报告阶段启动一次完整有头运行；脚本生成阶段本身不执行。`prd-to-script`/`script-only` 明确拆开时只生成准备产物，随后通过 `promote-prepared` 进入执行。完整脚本在同一个 Browser/Context/Page 中先执行轻量运行时预检，再进入第一次写操作。每条适用稳定性规则必须通过 `recordStabilityRule` 记录合法终态；到达 mutation 前规则时不得仍为 `active`。

默认不额外运行独立 `--dry-run` 或 `--preflight-only`。`--dry-run` 仅用于参数/契约专项诊断；`--preflight-only` 仅用于环境、登录、权限、全局上下文或页面入口专项诊断。两者都不是每日执行前的固定步骤。

同一 Case 和同一执行契约重复生成时使用稳定脚本路径，不创建日期后缀副本、Case 目录或版本目录。修复时覆盖并保留固定根产物 `case.md`、`handoff.json`、`script.js`、`result.json` 和 `report.html`；保留的失败结果、checkpoint、截图、日志和失败分析都位于同一 Case 的 `artifacts/`。组件或契约变化后覆盖稳定实现。

## 执行到报告

每次执行向报告阶段提供：脱敏描述、实际脚本、脱敏命令、结果 JSON、截图、日志、网络证据、resume 证据和失败分析。报告结论依据实际执行结果和步骤状态；不得把缺少静态检查、历史兼容认证字段或稳定性门禁字段追溯为本次失败。每次 `complete` 返回 `prepared`、`artifact-ready` 或 `completed` 前，状态管理器都必须重新扫描当前工作区的真实交付布局，不接受调用方提供的旧报告或通过证据替代。最终完成还必须验证当前 Case 的结果 JSON 属于本次运行、`result.ok=true`、`stabilityGate.finalAssertion.status='passed'`，并且非空对象 `stabilityGate.finalAssertion.evidence`、有效 HTML 报告和用户明确确认全部存在；任意 `assertionEvidence`、preflight evidence、失败状态、空 evidence、失败报告、布局失败或未确认状态都不能写入 `completed` 或其他终态。`report-only` 可以从当前 Case 的失败或缺证据 `result.json` 生成 `report.html`，但只能进入 `artifact-ready`/`report-ready`。

## 失败与修复边界

自动修复期间，Case/handoff 中的断言、side effects、账号/环境边界和数据策略不可变；不得通过改预期、删除/弱化/跳过断言、替换运行数据或重放业务副作用使 Case 通过。`automation-startup`、`automation-assertion` 和 `automation-technical` 可在执行阶段自动进行最多两轮最小技术修复；`environment-auth-input`、`unknown`、checkpoint 不安全或耗尽时停为 `执行阻塞`。只有证据确认的 `product-defect` 停为 `不可提测`。

每次失败在当前 Case `artifacts/` 写入分析，并调用 `record-failure`。修复 ledger 至少记录 `roundsUsed`、`maxAutomaticRounds`、`fingerprint`、`repairSummary`、`retryPlan`、`verification` 和 stop reason；完成修复后调用 `finish-repair`。`full-before-mutation` 只可用于 mutation 前；已有不可逆副作用时必须使用已登记、同 Case 且同运行上下文的 `resume-from-checkpoint`。不得重复任何已完成的不可逆阶段。

同一失败指纹在只读阶段重复出现时，不得仅通过替换运行输入规避失败。先比较失败阶段、首条错误、登录或鉴权方式、URL、渲染上下文和截图。

## 秘密与脱敏

- 只记录秘密参数名称和注入方式，不记录具体值。
- Case、handoff、组件、脚本默认值、命令示例、日志、结果 JSON、历史兼容认证字段、失败分析和报告不得包含秘密原文。
- 个人标识在控制台与报告中使用脱敏值。
- HTML 中的本地产物链接不得携带 Cookie、Token 或 session 参数。
