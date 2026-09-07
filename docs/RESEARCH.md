# Research and design decisions

The v0.2 agent review checked the primary [Codex non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic-use guide](https://code.claude.com/docs/en/headless) and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) on **2026-09-07**. The adapter decisions below were compared with this checkout's source. Upstream capabilities and code inspection are separate from live Testloom validation.

## Established recorder workflows

| Primary reference | Existing capability | Testloom's design choice |
| --- | --- | --- |
| [Playwright test generator](https://playwright.dev/docs/codegen) | Action recording, locator generation and explicitly selected assertions | Keep user expectations distinct from recorded behavior and review locator choices |
| [Playwright VS Code integration](https://playwright.dev/docs/getting-started-vscode) | Recording, execution, debugging and trace inspection in an editor | Make the desktop useful through editable suites, project adaptation and understandable evidence |
| [Chrome DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder) | Recording, replay, editing and export of browser flows | Treat a recording as a reusable input, not a specification of business correctness |
| [Selenium IDE](https://www.selenium.dev/selenium-ide/) | Open-source record/playback workflows and reusable commands | Acknowledge prior art rather than claim recording or reusable tests are new |

These references carry forward the v0.1 design review. Testloom combines a local project, recorded journey, explicit requirements, editable variants, agent/template generation and execution evidence. This is not a claim to invent recording, AI-generated tests or assertions. The name and this focused review do not establish trademark clearance, patent clearance or global novelty.

## Codex as the primary adapter

The [non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode) documents CLI execution, JSON events, schema-constrained final output and saved authentication. Testloom uses that interface with an explicit read-only sandbox and a fresh temporary working directory. It sends the reviewed bounded prompt through stdin, then validates the returned summary, warnings and file list. There is no Codex SDK dependency.

Model and effort settings are passed to the installed CLI; the app does not promise every account/model combination. Temporary agent files are cleaned after the invocation. The user's CLI configuration still matters, so an empty working directory is not a claim that all possible local reads or integrations are confined to the prompt. See [Agent controls](AGENTS.md).

## Claude as a portable CLI alternative

Anthropic documents [non-interactive print mode and structured output](https://code.claude.com/docs/en/headless). Testloom reads the terminal structured result, rejects failed completion and permission-denial results, and applies the same generated-file contract as Codex. It does not parse arbitrary prose into a patch.

The [CLI reference](https://code.claude.com/docs/en/cli-reference) distinguishes available tools from approval rules and documents model, effort and dollar-budget controls. Testloom disables built-in tools and supplies an empty strict MCP configuration, disables hooks/plugins and session persistence, and starts outside the project. Its authentication remains the user's CLI responsibility. The adapter does not use bare mode because that mode omits subscription/keychain authentication, as described in [programmatic use](https://code.claude.com/docs/en/headless).

Claude is an alternative authoring adapter, not a dependency of the suite format or exported tests. The per-case budget is passed to the CLI; it is not a Testloom billing service or batch-wide cap. Documented flags and local adapter tests do not establish a successful live-provider run.

## Preserve assertions and inspect execution

The [Playwright tracing API](https://playwright.dev/docs/api/class-tracing) distinguishes browser-operation traces from assertion-aware Playwright Test tracing. Testloom therefore keeps user-authored requirements separate from traces and screenshots. A recorded $95.00 total cannot overwrite the requirement for $90.00.

The [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) supports structured discovery evidence. Testloom's generated-files command disables retries and inspects report outcomes. File discovery is stronger than an unexplained zero exit status, but does not independently prove complete assertion coverage. Java/custom runner adapters remain roadmap work.

The [webServer configuration](https://playwright.dev/docs/test-webserver) supports owned startup and optional server reuse. The desktop demo uses its selected loopback port and copied config; controlled mutation checks need a fresh server so a healthy existing process cannot hide the defect.

## Desktop isolation and source context

Electron's [context-isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [security recommendations](https://www.electronjs.org/docs/latest/tutorial/security) motivate the narrow preload API, sender checks, isolated renderer and restricted navigation. The recorded website lives in a separate browser. Neither renderer isolation nor a source copy is an OS sandbox for trusted project commands.

Context selection is explicit and bounded: cached tests/helpers/configuration, user-added project files, exclusions and an outgoing prompt preview. This is not full-codebase ingestion or dependency-aware retrieval. Screenshots remain outside generation. Heuristic redaction and schema/path checks reduce exposure and bad writes without establishing confidentiality or test correctness.

## Evidence required for a release claim

Use [VALIDATION.md](VALIDATION.md) for actual commands, versions, environments and outcomes. Keep real browser recording, native desktop, packaged app, Java, each live provider and each batch check distinct. A healthy pass plus the same test failing on a disclosed defect supports that demonstrated behavior. A missing output, timeout or provider outage does not. Prior v0.1 evidence cannot certify the v0.2 feature set.
