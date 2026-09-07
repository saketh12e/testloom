# Architecture

This describes the 0.1 contract in `src/shared/types.ts`, the source structure, and decisions from `docs/BUILD-PLAN.md`. Actual checks are recorded separately in [Validation](VALIDATION.md).

## Data flow

```text
Trusted local project ── inspect ──> Project + example tests + commands
                                       │
Browser actions ── recorder ──> Scenario + user-authored assertions
                                       │
                         Separate project snapshot
                                       │
                 Codex generation / portable templates
                                       │
                    Validate files → reviewable patch
                                       │
                 Selected test command → Verification
                                       │
                          Evidence export and review
```

The desktop renderer presents state and user actions. The main process owns native operations, project access, the recorder browser, generation, child processes, and exports. A preload bridge exposes the narrow `JourneyAPI`; it should not expose raw IPC, arbitrary filesystem access, or a general command runner to web content. The recorded application runs in a Playwright browser rather than the privileged desktop interface.

## Shared contracts

| Type | Responsibility |
| --- | --- |
| `Project` | Canonical project path, framework/build-tool clues, sample test content, candidate commands, generated output directory. |
| `InteractionEvent` | Ordered action, page identity, URL, locator candidates, optional value/redaction/screenshot/warnings. |
| `Scenario` | Schema version 1, start URL, recorded events, separate assertions, warnings, and method/URL/status network metadata. |
| `Assertion` | An explicit user requirement: text, visibility, URL, or custom; always `source: 'user'`. |
| `Generation` | Provider (`codex` or `portable`), proposed files, workspace, patch, summary, warnings, generation time. |
| `Verification` | Actual command and individual runs, with exit code, duration, output, and distinct failure/environment/timeout/cancellation states. |
| `AppState` | Project/scenario/results, activity, errors, CLI availability, workspace root, and active phase. |

`JourneyAPI` separates choosing a project or loading a demo, starting/stopping recording, saving assertions, generating, verifying, exporting, revealing the workspace, cancellation, and state subscriptions. UI readiness and transitions must follow the main process state rather than assume a successful click completed the operation.

## Project copy and generation

`src/core/repository.ts` detects npm, Maven, or Gradle and a bounded set of test examples. Detection is heuristic. Snapshots omit selected dependency/build folders, symlinks, and recognizable credential files. They record source provenance and enforce file-count, depth, individual-size, and total-size limits. Exclusions are not a complete secret detector, and omitted dependencies must be supplied in the copy.

Generated paths are constrained to the project's output directory, reject traversal and duplicates, and refuse to overwrite existing files. The TypeScript portable path is `tests/journeyproof/<slug>.spec.ts`; Java output belongs under `src/test/java/journeyproof`. Schema-conforming output still needs path validation and human review.

Codex generation uses the documented noninteractive `codex exec` CLI with a read-only sandbox, an empty working directory, and a JSON output schema. Its prompt includes bounded, redacted tests, helpers, build configuration and the scenario ledger. The original repository path is not passed to the agent. The installed Codex runtime retains its configured capabilities within its sandbox; this is not a claim that all local reads are confined to that prompt. There is no Codex SDK dependency and no screenshot attachment to generation in 0.1. The app validates returned files and writes append-only tests into its copy. Portable generation uses deterministic supported templates without a model call. Custom assertions and unsupported events must not be represented as successful verification merely because a file was produced.

## Recorder and requirements

The recorder captures supported DOM actions and locator candidates, favoring stable test IDs and accessible controls. Sensitive field values are redacted and unsupported actions generate warnings. Stopping must flush pending actions before generation. Screenshots and traces are evidence, not a substitute for user requirements: a recorded buggy total cannot define the expected total.

The first recorder has limits including frames, uploads, canvas gestures, and complex multi-page flows. The shared event vocabulary being able to name an action does not establish complete replay support. See [limitations](LIMITATIONS.md).

## Demo ownership

The bundled fixture is `examples/cart`, an independent npm project with a dependency-free Node HTTP server and a pinned Playwright test runner. `loadDemo` in the desktop owner is responsible for copying the fixture, starting `server.mjs`, waiting for readiness, selecting the copied project, and managing server lifetime. Its default loopback port is 4318; `PORT` overrides it. The sample does not implement desktop IPC or process ownership.

The desktop service stops its demo server before verification; Playwright's `webServer` then starts the copied `server.mjs` at the same URL. Demo dependencies are prepared automatically with `--ignore-scripts`; other projects require their own setup. Ordinary standalone tests may reuse an existing server, but CI, fresh-server, and mutation runs refuse reuse so a stale healthy process cannot hide the injected defect. Browser contexts receive separate cookie sessions; the server calculates amounts in cents. The baseline smoke journey does not exercise SAVE10. The `checks` suite is only selected by `test:contract`; generated tests use normal `tests/journeyproof` discovery.

## Verification and trust

`src/core/process.ts` starts an executable with argument arrays, captures bounded output, and supports timeout and cancellation. Avoiding shell interpolation does not make the invoked repository script safe. npm scripts, Maven/Gradle plugins, subprocesses, and browser requests can act outside the working directory with local user rights. A project snapshot is not an OS sandbox.

Results are per run, with environment errors distinct from assertion failures. Generated files are checked against the proposed bytes before and after verification and again before export; SHA-256 hashes bind evidence to those test bytes. Manually edited generated tests must be regenerated before verification or export. The recommended Playwright command targets generated test files and emits a JSON report. The app accepts only discovered, passing tests with no skipped, expected-failure or retry-only results. Custom commands retain the weaker meaning of successful process execution. Repeated success does not prove general reliability.

Cancellation terminates only the process group owned by the run, escalates to SIGKILL after a bounded grace period, and awaits cleanup even when its leader exits first. Application shutdown waits for that cleanup. The recorder bridge authenticates packets using a per-session nonce captured before page scripts execute, validates packet sizes and semantics, and caps event/network counts. Stop uses an authenticated callback and a bounded flush deadline. These mitigations are tested but do not turn page-world recording into a fully isolated security boundary.
