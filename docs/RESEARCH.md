# Research and design decisions

Official primary documentation checked live on **2026-09-07**. These sources describe upstream capabilities; the decisions below are JourneyProof's engineering choices. They are not independent verification of this application's implementation.

## Existing recorders and prior art

| Primary source | What already exists | JourneyProof decision |
| --- | --- | --- |
| [Playwright test generator](https://playwright.dev/docs/codegen) | Interactive action recording, locator generation, and explicitly selected visibility/text/value assertions. | Do not claim that recording tests or adding assertions is new. Keep explicit requirements alongside recorded actions and review generated locators. |
| [Playwright VS Code integration](https://playwright.dev/docs/getting-started-vscode) | Recording, running, debugging, and trace inspection integrated with an editor. | A desktop workflow must earn its place through project adaptation and understandable evidence, not claim to be the first integrated test tool. |
| [Chrome DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder) | Recording, replaying, editing, exporting, and measuring browser flows. | A browser flow is a useful input artifact; recording alone does not establish the intended business outcome. |
| [Selenium IDE](https://www.selenium.dev/selenium-ide/) | Existing open-source record-and-playback testing, reusable commands, and control-flow features. | Acknowledge established recorder workflows. Do not describe Selenium users as lacking recording tools. |

JourneyProof's proposed contribution is **integration**: connect a local test repository, record a journey, attach user-authored requirements, adapt or generate reviewable tests, execute the selected command, and package the evidence. Requirements and verification are central to that combination. No claim of inventing record/replay, assertion generation, AI-generated tests, or a globally unique product is made. This is a focused prior-art review, not an exhaustive novelty or patent search.

## Playwright: actions, assertions, and traces

[Playwright codegen](https://playwright.dev/docs/codegen) can record actions and assertions that a person selects. It does not determine a shop's correct discount policy merely from observed behavior. **Decision:** store requirements separately as `Assertion` objects with `source: 'user'`; the user specifies that SAVE10 must yield $90.00 even when a mutated app displays $95.00.

The [Tracing API](https://playwright.dev/docs/api/class-tracing) documents a concrete distinction: `context.tracing` records browser operations and network activity, but not test assertions such as `expect` calls. Tracing configured through Playwright Test includes assertions. **Decision:** do not treat a raw recording trace as a tested requirement; use the selected runner's result and review its assertion evidence. Traces are diagnostic artifacts, not proof of comprehensive coverage.

[Playwright webServer configuration](https://playwright.dev/docs/test-webserver) manages startup and supports reusing an existing process. **Decision:** the sample's normal local run can use the app-owned server, while CI and mutation checks require a fresh one. Otherwise, setting a mutation environment variable could accidentally test an already-running healthy server. The sample uses one managed Chromium project; this does not claim coverage across browser engines.

## Electron: isolation is a boundary, not a blanket guarantee

[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) separates preload and page JavaScript contexts. It also warns that exposing unfiltered IPC remains unsafe. **Decision:** expose one narrow method per supported operation through a typed preload API, validate calls in the privileged process, and avoid giving the recorded website access to desktop capabilities.

Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) recommends context isolation, renderer sandboxing, disabling Node integration for remote content, limiting navigation/window creation, and validating IPC senders. [Process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) explains renderer restrictions and privileged delegation. **Decision:** keep desktop UI privileges separate from the Playwright page. Neither renderer isolation nor copying a project provides OS isolation for npm/Maven/Gradle scripts. Those commands can have external effects with the user's permissions.

## Codex: structured generation and account ownership

The official [noninteractive-mode documentation](https://developers.openai.com/codex/noninteractive) documents `codex exec`, JSONL event output via `--json`, and a schema-conforming final response requested with `--output-schema`. Its [CLI reference](https://developers.openai.com/codex/cli/reference) also documents the output path, working directory, and sandbox options. These URLs currently redirect to OpenAI's ChatGPT Learn documentation. The local `codex exec --help` was also inspected to confirm the relevant options.

**Decision:** use noninteractive CLI execution and a structured final file list, rather than interpreting prose as an unrestricted patch. Run read-only generation in an empty working directory with bounded, redacted test examples and the scenario ledger. There is no SDK dependency. Screenshots are not currently attached to generation; opt-in recent screenshots are planned. Validate returned paths, sizes, duplicate names, and allowed output directories before appending tests into the copy. Schema conformance is not a correctness or security proof. The verification phase separately executes trusted project commands with local user rights.

The official [authentication documentation](https://developers.openai.com/codex/auth) describes signing in with a ChatGPT account and a separate API-key option. **Decision:** JourneyProof's documented setup uses the user's installed CLI and account login. JourneyProof collects no API key and does not supply model credits. Existing CLI configuration and account policies govern access and data handling. Portable generation avoids a model call; Codex mode is not an offline operation.

## Release evidence

The release validation exercises the real desktop flow, recording-to-test integration, actual Codex generation, and Java compilation/execution. Healthy and deliberately broken discount fixtures distinguish successful execution from defect detection. Commands, versions and outcomes are recorded in [Validation](VALIDATION.md). Research citations alone cannot supply this evidence.

The official [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) documents structured run output and the `PLAYWRIGHT_JSON_OUTPUT_FILE` environment variable. JourneyProof's recommended command targets generated files and uses this report to reject missing, skipped, expected-failure, or retry-only results. This checks runner evidence; it does not independently prove assertion completeness or protect against a malicious trusted test runner.
