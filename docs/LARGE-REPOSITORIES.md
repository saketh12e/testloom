# Large repositories and case sessions

Testloom 0.3 connects each test case to a dedicated native Codex or Claude Code conversation. Generate sends the current ordered ledger, explicit expectations and captured screenshots; repository tools let the agent inspect relevant source, test fixtures and backend contracts as needed. Generated code is a proposal in a separate source copy. Review it before choosing Verify.

## Large folders

The 8,000-file and 250 MB snapshot limits have been replaced with concurrent scanning and bounded streaming copies. Defaults allow **1,000,000 included files**, directory depth **64**, **2 GiB per file** and **50 GiB total**. These are resource ceilings, not claims that every repository at those sizes has been tested. Recognizable credential files, dependency/build caches and symlinks are excluded. This is a filesystem scan, not a Git dependency graph or a continuously maintained semantic index.

A scan reports progress and can be cancelled. Each generation batch gets a fresh source copy and provenance manifest. Copying uses filesystem cloning when available and a streaming fallback otherwise; it never hard-links test workspaces to the original. File identity and metadata are checked around reads. A concurrent repository-wide edit is not an atomic revision snapshot; generate from a stable working tree when exact revision provenance matters.

A synthetic **100,000-TypeScript-file fixture plus package.json** passed on an Apple M4 with Node 22.22.3:

| Measurement | Observed |
| --- | --- |
| Inspect folder | 166 ms |
| Copy and hash, including fresh scan | 22,716 ms |
| Peak process RSS | 166.28 MiB |
| Independently checked copied files | 100,001 |
| Total fixture bytes | 3,277,860 |

The benchmark used freshly created tiny files and the streaming fallback; cloning was unavailable on that runtime. Fixture creation, the additional independent verification and cleanup are outside the timed scan/copy figures. Large files, slower disks and complex build setups change the result. Reproduce with `npx tsx tests/repository-scale.integration.ts`.

## Context on demand

Connecting a folder reads a small starter sample; the native context picker can pin extra files. The prompt still has a finite context budget. Agents can then use:

- `repository_list` and `repository_search_paths`: up to 200 paths per page, with continuation cursors.
- `repository_read`: up to 64 KiB or 1,000 lines per call, with continuation metadata.
- `repository_grep`: literal content search, bounded to 8 MiB of scanned bytes, 200 results and five seconds per call. Narrow the path or glob when results are incomplete.

Tool results identify truncation rather than implying that unseen files do not exist. Paths remain inside the current source copy; credential paths, agent instruction files, symlinks and user exclusions are denied, and returned text is heuristically redacted. The same tools are exposed through Codex App Server dynamic tools and a dedicated Claude MCP server. They have no write or shell operation.

The **8,000-character instruction field** remains a separate text budget. It is unrelated to the source-file count. The prompt preview shows starter excerpts and the current ledger; the scope notice also names screenshots and later repository reads. It does not display provider system instructions, native history or future tool results.

## Native conversations and memory

A new `(project folder, case, provider)` gets a new native session. Later generations resume it, including after an app restart. Codex uses App Server `thread/start`, `thread/resume` and `turn/start`; Claude uses its native `--session-id` / `--resume` interface. Native conversations retain their prior turns. Session IDs, turn counts and a small recovery summary are saved locally by Testloom. These are CLI conversations; visibility in a provider's browser chat interface is not guaranteed.

The session panel identifies the selected case/provider and offers **Start fresh session**. Reset affects only that pair and creates a new conversation on the next generation. It retains previous native history locally. Changing context exclusions also starts a fresh conversation so an excluded source is not still carried in a resumed prompt; it does not erase history already sent to the provider. Deleting a case or pruning run history does not delete native transcripts or old workspaces.

Current requirements and current source reads take precedence over earlier turns. Conversation memory is useful context, not evidence that a test passed. There is no guarantee of infinite model memory: context windows, compaction, retention and authentication belong to the installed provider.

## Reasoning and review

**Maximum** is the default for new settings. Codex resolves the highest level advertised for the selected model; the live validation model advertised `ultra`. Claude receives `--effort max`. Explicit lower saved settings remain respected. Account/model support is checked by the provider; maximum reasoning can take longer and does not guarantee correctness.

Captured screenshots are sent as native images with event labels. Missing or unsafe referenced images stop generation. A case may attach at most 100 images, 10 MB each and 50 MB total in the app flow; oversized evidence asks you to split the case, rather than silently dropping images. Screenshots can still contain visible private data despite recorder masking.

Before Generate, the interface states what is sent and where output goes. The coding agent can inspect the source copy and return proposed test files; it cannot run project commands or write the connected source. Testloom writes validated proposals to the isolated copy. Verification only starts when you choose it. Project test commands run with your Mac permissions, so this generation boundary does not sandbox npm, Maven, Gradle or browser side effects.

See [Validation](VALIDATION.md), [Agent controls](AGENTS.md), [Limitations](LIMITATIONS.md) and the [official Codex App Server](https://learn.chatgpt.com/docs/app-server) and [Claude session](https://code.claude.com/docs/en/headless) documentation.
