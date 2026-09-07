# Release validation — 0.2.0

Checked on **2026-09-07**, on **macOS 26.5.1 / Apple Silicon**. Electron **44.2.0**; Node **22.22.3**; Playwright TypeScript **1.63.0**; Playwright Java **1.62.0**; Temurin **17.0.20.1**; Maven **3.9.16**. Codex CLI **0.153.4**; Claude Code CLI **2.1.116**.

## Results

| Check | Observed result |
| --- | --- |
| `npm run check` | Formatting, TypeScript, **81 regression tests**, and the production build passed. |
| `npm run test:suite` | Positive, negative, and boundary cases passed **2 healthy runs**. The unchanged positive test failed on the deliberate 5% discount defect: **$90.00 expected / $95.00 received**. Source unchanged. |
| `npx tsx tests/batch.integration.ts` | **20 generated files / 20 discovered and passing tests** in one selected batch. |
| `TESTLOOM_AGENT=codex npx tsx tests/agent.integration.ts` | The actual Codex CLI authored positive and negative cases. Both were discovered and passed **2 healthy runs**; the unchanged positive test detected the discount mutation. All explicit requirement IDs were retained. Original source digest unchanged. |
| `npx tsx tests/java.integration.ts` with the documented JDK/Maven environment | A real browser recording plus negative/boundary examples compiled into **3 Java/JUnit tests**. All passed on the healthy cart; the unchanged positive test failed on $90.00 versus $95.00. The shipped Java dependency version was used. Original Java and cart source digests unchanged. |
| `npm run test:desktop` | Real Electron UI: edit an expired-coupon variant, duplicate it, save Claude controls, preview the prompt, select/generate 3 cases, verify twice, and export matching test bytes and verification hashes. Then record a fresh 5-event journey, author its requirement, generate and verify twice. Import **500 total cases**, search, and confirm the **20-case selection cap**. **Zero renderer errors.** |
| Packaged app | **Passed the same real desktop workflow against the packaged `.app`**: 500 cases, editing, generation, verification, import/export, recording, and zero renderer errors. |
| Claude adapter | Structured-response, error, output-size, timeout, cancellation, flag and context tests passed. **No successful live Claude generation is claimed.** The installed CLI reports signed in, but direct Anthropic requests return **HTTP 401**; this Mac's saved third-party model route did not complete within the bounded attempt. Renew/configure a working Claude Code account/route, then run the opt-in integration below. Testloom does not change account settings. |

The desktop screenshots in `assets/` are captured from actual application states. Temporary toast notifications are hidden in documentation screenshots. No backend state is mocked. The desktop test substitutes only native file dialogs to choose its own temporary import/export files.

## What the regression suite checks

- Positive/negative/boundary case cloning, explicit and empty-text requirements, strict suite validation, unique identities, bounds, safe import/export, and screenshot-path removal.
- Source snapshots, credential exclusions/redaction, generated path and symlink checks, refusal to overwrite existing files, and verification bound to the generated file hashes.
- Missing, skipped, retried, expected-failure, interrupted, or mixed passing/skipped generated-test reports cannot produce confirmed discovery success.
- Browser event ordering/coalescing, keyboard actions, sensitive input masking, authenticated recorder packets, bounded flushes, and unsupported-action warnings.
- Child-process timeout/cancellation and owned descendant cleanup; cancellation before recording startup; crash recovery with an existing case library; v1 migration; per-project library persistence; byte-identical recovery copies of corrupt sessions.
- Provider settings, context selection/exclusion and bounds, JSON framing, malformed/failed terminal results, stale-response prevention, and controlled CLI arguments.

## Reproduce

```sh
npm ci
npm run browsers
npm run check
npm run test:journey
npm run test:suite
npx tsx tests/batch.integration.ts
npm run test:desktop
```

The desktop check needs a graphical Mac session and free test-only debugging port **9437**. Its cart chooses a free local port. The separate recording integration owns **4318**; Java owns **4329** and requires the [Java example prerequisites](../examples/java/README.md).

Live account tests are explicit opt-ins and consume the selected account's usage:

```sh
TESTLOOM_AGENT=codex npx tsx tests/agent.integration.ts
TESTLOOM_AGENT=claude npx tsx tests/agent.integration.ts
```

Optionally set `TESTLOOM_MODEL` to an available model. The script generates positive and negative cases, verifies twice, runs a disclosed mutation, checks source digests, and stops its own processes. An authentication error, routing failure, or timeout is not a passing generation result.

To check a built app:

```sh
npm run package:mac
TESTLOOM_EXECUTABLE="$PWD/release/mac-arm64/Testloom.app/Contents/MacOS/Testloom" npm run test:desktop
```

Working reports under ignored `work/` contain the actual local run data; source and release archives exclude those private working files. The GitHub workflow separately runs deterministic checks without AI credentials. Read its completed status for the release commit.

## Limits of the evidence

These tests cover the stated sample behaviors, protocol boundaries, and demonstrated library/batch sizes. They do not establish complete business-rule coverage, universal project compatibility, clean-Mac installation, or a successful live Claude call. Maven/custom commands currently have weaker automatic discovery assurance than the recommended Playwright JSON command; the Java validation above inspects actual Maven/Surefire results. The distributed app is **unsigned and unnotarized**.
