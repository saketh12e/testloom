# Testloom 0.2 developer preview

Testloom replaces the JourneyProof product name and expands the single-journey workflow into an editable project case library. This release targets **Apple Silicon macOS** and remains **unsigned and unnotarized**. Check [Releases](https://github.com/saketh12e/testloom/releases) for published assets;

## What changes

- Persist up to **500 cases per project**, with libraries restored when switching folders. Select **1–20 enabled cases** for sequential batch generation.
- Edit case inputs, locators, assertions, name, kind, tags, priority and enabled state. Duplicate positive, negative and boundary variants while retaining the original recording.
- Import/export **v2 suite JSON**, with v1 scenarios inside it. Validate imported fields, IDs and bounds; discard imported screenshot paths.
- Use **Codex**, the primary agent, **Claude Code** as an alternative, or deterministic **Portable** generation. Generated tests run independently of Testloom and AI.
- Set model, low/medium/high effort, **30–1,800 seconds per case**, **8,000-character instructions**, source exclusions and a **$0.01–$20 Claude cap per case**.
- Add specific project files through the native context picker and preview the outgoing case prompt. Context is bounded and cached, not a full-codebase index. See [Agent controls](AGENTS.md) for the separate selection and prompt limits.
- Keep generated output in separate case folders under `tests/testloom` or `src/test/java/testloom`. Retain the latest **100 generation records**, with verification status updates.
- Open the cart demo with **three hand-authored cases** ready to generate: valid, invalid and empty coupons. Record an additional journey whenever needed.

Expected rejection is an ordinary passing test when its assertions hold. A negative label does not turn crashes, timeouts, skipped tests or unexpected behavior into success.

## Compatibility

The repository is `saketh12e/testloom`; the old GitHub URL redirects here. Recognized JourneyProof app data is reused, and `.journeyproof` metadata plus the Electron app ID remain intentional compatibility names. New portable Java declares `package testloom`. Follow [Migration](MIGRATION.md) before changing data locations or adopting new generated paths.

## Evidence and rollout

The v0.2 checks exercise the cart's explicit discount requirements:

| Check | Result |
| --- | --- |
| Live Codex CLI, positive + negative cases | Two generated files passed two healthy repeat runs; the unchanged positive test failed on $90.00 expected / $95.00 received. Full original-source hash unchanged. |
| Portable selected batch, positive + negative + boundary | Three cases passed two healthy repeat runs; the discount mutation failed the positive case. Original source unchanged. |
| Playwright Java, positive + negative + boundary | All three compiled and passed on the healthy cart. The mutation failed the positive assertion while rejection/boundary cases passed. Original source unchanged. |

Exact commands, versions and remaining checks belong in [VALIDATION.md](VALIDATION.md). These results do not establish a live Claude run, clean-machine installation or arbitrary-project compatibility.

The preview still has page-world recording, heuristic redaction, module-size limits, incomplete replay coverage and weaker discovery assurance for Java/custom commands. Source copies protect against app-generated writes to the original; they do not sandbox trusted project scripts or external browser effects. See [Limitations](LIMITATIONS.md).

Start with the demo and a small trusted test module. Review generated requirements, prove a healthy pass and a known-defect failure, and repeat on your intended machine. Broader rollout needs signed/notarized distribution, clean-machine checks, provider compatibility evidence and additional runner adapters. [Roadmap](ROADMAP.md) lists concrete completion criteria. Storage for 500 cases is a capacity bound, not evidence of thousands of verified tests or production readiness.
