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
| Effort | `low`, `medium`, `high`, `xhigh`, `max` | `max`; Codex resolves its model catalog maximum, Claude uses `max`; saved lower choices remain respected |
| Generation time | Whole seconds, **30–1,800 per case** | 480 seconds; separate from verification's timeout |
| Instructions | At most **8,000 characters** of plain text | Empty; naming, style and fixture preferences |
| Context exclusions | At most 100 relative paths/patterns, at most 500 characters each | Empty; supports `*`, `**`, `?` and directory prefixes |
| Claude budget | **$0.01–$20 per case** | $1; passed to Claude's CLI budget option |

Cases in a selected batch are generated sequentially. Time and Claude dollar limits apply to each invocation, not to the whole batch. Twenty cases at the default $1 setting mean twenty separately capped calls. This is a provider-side API-spend control, not a prepaid allowance, refund mechanism or account-wide billing limit. Testloom has no equivalent Codex dollar-cap control. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents the upstream budget and effort flags.

Instructions do not change saved assertions. The prompt tells the agent to preserve every requirement and reject conflicting preferences. Review the generated code: prompt instructions cannot prove that the model obeyed.

## Choose and preview context

Connecting a folder caches a bounded sample of tests, helpers and build configuration. **Add context files** opens a native picker for specific tests, page objects, helpers or configuration inside the connected project. The combined list allows 30 files; added files must be no larger than 500,000 bytes, and only their first 10,000 characters are cached. Recognizable credential files are rejected.

The prompt applies an additional limit: **30 excerpts, 10,000 characters per file and 150,000 source characters total**. It filters built-in exclusions and your patterns before selecting excerpts. The whole prompt is capped at 300,000 UTF-8 bytes. Adding a file does not guarantee it fits into the outgoing prompt; preview it and exclude irrelevant earlier excerpts if necessary.

Starter excerpts are read when connecting or adding files. During generation the agent can list, search and read additional files in the fresh source copy through the read-only repository tools. It does not ingest the entire codebase into a single prompt or resolve an entire dependency graph. Reconnect to refresh starter inspection. See [Large repositories](LARGE-REPOSITORIES.md).

Use relative exclusions such as `fixtures/private/**`, `support/internal.ts` or `**/*.local.ts`. Absolute paths and traversal are rejected. Exclusions affect starter excerpts and on-demand repository tools. Changing exclusions starts a fresh native session on the next generation; it does not erase previously transmitted history, remove scenario text, redact screenshots or change the separate snapshot policy.

The selected-case preview uses the same prompt builder as generation. Save case and settings edits first, inspect each selected case's preview, and review after changing context. It includes user preferences, bounded project excerpts and scenario data. Captured screenshots are attached separately as native images during generation, with the count shown before Generate. The preview does not enumerate the CLI's own system instructions, account configuration or integrations.

## Execution boundary

Codex connects directly to the installed `codex app-server` over stdio. Each case gets a durable thread, resumes on later generations and receives schema-constrained turns. Testloom disables unrelated shell, app, memory-import and MCP integrations for those threads and supplies bounded read-only repository tools. Global account configuration remains unchanged. Native session history is retained. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

Claude uses print mode, native persistent sessions and structured output, with labeled screenshot images in stream-json user input. Built-in tools, hooks and plugins are disabled; strict MCP exposes only Testloom's read-only repository server. The adapter preserves CLI authentication and accepts only a successful terminal `structured_output`. See [Claude programmatic use](https://code.claude.com/docs/en/headless).

The session panel exposes the case's native session ID, successful turn count and reset control. Session ownership is separated by canonical project path, case and provider. **Start fresh session** detaches only that case/provider; it does not delete prior provider transcripts. Claude native session creation was observed in live testing, but its configured API rejected authentication with HTTP 401. Live Claude test generation remains unverified on the validation Mac.

Both adapters validate result shape, file sizes and permitted output paths. These controls reduce accidental access and unsafe writes; they are not an OS sandbox or proof of correct assertions. Custom instructions and context have no effect on Portable's deterministic templates.

Cancel requests termination of Testloom's owned process group and prevents subsequent cases from starting. Wait for the app to return to idle. Cancellation cannot undo completed provider requests, charges or external side effects. Failed or cancelled generation does not produce a verified batch. See [Architecture](ARCHITECTURE.md) and [Limitations](LIMITATIONS.md).
