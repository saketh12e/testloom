# Agent setup and controls

Codex is Testloom's primary test-authoring adapter. Claude Code is an alternative; Portable uses deterministic Playwright TypeScript or Java templates without a model call. All three produce ordinary files for review and separate verification.

## Connect your CLI

Install the [official Codex CLI](https://developers.openai.com/codex/cli), run `codex login`, and check `codex --version`. For Claude, follow the [official setup](https://code.claude.com/docs/en/quickstart), complete its login and check `claude --version`. Refresh availability in Testloom after installation; restart the app if its environment has not picked up the executable.

Testloom collects no API key and provides no model allowance. The installed CLI's authentication, provider configuration and account policies govern usage. An available executable is not proof of a working login, supported model or successful generation. Portable needs no provider account; installing dependencies and running browser tests can still need network access.

## Save controls before generating

These are Testloom's validated settings in `src/core/agents.ts`, not a promise that every model supports every choice.

| Control | Accepted value | Default and meaning |
| --- | --- | --- |
| Provider | `codex`, `claude`, `portable` | Codex |
| Model | Blank or a validated identifier, at most 160 characters | Blank uses the CLI default; no fixed model is bundled |
| Effort | `low`, `medium`, `high` | `medium`; unsupported provider/model combinations can fail |
| Generation time | Whole seconds, **30–1,800 per case** | 480 seconds; separate from verification's timeout |
| Instructions | At most **8,000 characters** of plain text | Empty; naming, style and fixture preferences |
| Context exclusions | At most 100 relative paths/patterns, at most 500 characters each | Empty; supports `*`, `**`, `?` and directory prefixes |
| Claude budget | **$0.01–$20 per case** | $1; passed to Claude's CLI budget option |

Cases in a selected batch are generated sequentially. Time and Claude dollar limits apply to each invocation, not to the whole batch. Twenty cases at the default $1 setting mean twenty separately capped calls. This is a provider-side API-spend control, not a prepaid allowance, refund mechanism or account-wide billing limit. Testloom has no equivalent Codex dollar-cap control. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents the upstream budget and effort flags.

Instructions do not change saved assertions. The prompt tells the agent to preserve every requirement and reject conflicting preferences. Review the generated code: prompt instructions cannot prove that the model obeyed.

## Choose and preview context

Connecting a folder caches a bounded sample of tests, helpers and build configuration. **Add context files** opens a native picker for specific tests, page objects, helpers or configuration inside the connected project. The combined list allows 30 files; added files must be no larger than 500,000 bytes, and only their first 10,000 characters are cached. Recognizable credential files are rejected.

The prompt applies an additional limit: **30 excerpts, 10,000 characters per file and 150,000 source characters total**. It filters built-in exclusions and your patterns before selecting excerpts. The whole prompt is capped at 300,000 UTF-8 bytes. Adding a file does not guarantee it fits into the outgoing prompt; preview it and exclude irrelevant earlier excerpts if necessary.

Content is read when connecting or adding files. Testloom does not ingest the whole codebase, resolve an entire dependency graph or continuously refresh excerpts. Reconnect to refresh inspection, then re-add specific files as needed. Project cases survive folder switching; manually added context is not a permanent repository index.

Use relative exclusions such as `fixtures/private/**`, `support/internal.ts` or `**/*.local.ts`. Absolute paths and traversal are rejected. Exclusions affect source excerpts in the prompt; they do not remove scenario text, redact screenshots, or change the separate source-snapshot policy.

The selected-case preview uses the same prompt builder as generation. Save case and settings edits first, inspect each selected case's preview, and review after changing context. It includes user preferences, bounded project excerpts and scenario data. Screenshots are omitted. The preview does not enumerate the CLI's own system instructions, account configuration or integrations.

## Execution boundary

Codex uses `codex exec` with a read-only sandbox, JSON events and a schema-constrained result in a fresh temporary working directory. The connected repository path is not handed to it. Saved CLI configuration can still affect capabilities and data handling. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

Claude uses print mode and structured output in a fresh temporary directory. The adapter disables built-in tools, supplies an empty strict MCP configuration, disables hooks/plugins and session persistence, and preserves CLI authentication. It accepts the terminal `structured_output` only after checking successful completion; prose and tool events are not generated-file authority. See [Claude programmatic use](https://code.claude.com/docs/en/headless).

Both adapters validate result shape, file sizes and permitted output paths. These controls reduce accidental access and unsafe writes; they are not an OS sandbox or proof of correct assertions. Custom instructions and context have no effect on Portable's deterministic templates.

Cancel requests termination of Testloom's owned process group and prevents subsequent cases from starting. Wait for the app to return to idle. Cancellation cannot undo completed provider requests, charges or external side effects. Failed or cancelled generation does not produce a verified batch. See [Architecture](ARCHITECTURE.md) and [Limitations](LIMITATIONS.md).
