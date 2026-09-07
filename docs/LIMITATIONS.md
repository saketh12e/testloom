# Limitations

Testloom v0.2.1 is an **ad-hoc signed Apple Silicon developer preview**. It is not Apple Developer signed or notarized. Gatekeeper may still block it; see [Mac installation help](MAC-OPENING.md). The [validation record](VALIDATION.md) describes actual version-specific checks, not universal framework support or production readiness. Capacity limits are not benchmark results.

## Recording and requirements

- Frames, file uploads, canvas gestures, multi-select controls, complex popups, downloads, dialogs and shadow-DOM edge cases need review or manual work. The event vocabulary is broader than portable replay support. Preserve warnings about incomplete or unsupported capture.
- The recorder uses page-world instrumentation with authenticated, bounded packets. It is not a fully isolated observation channel against hostile pages.
- Authentication, CAPTCHA, MFA, expiring sessions, fixture data and external services can prevent replay. A fresh browser context is not automatically signed in. Removed secrets cannot be recovered from a recording.
- URL observations remove query, fragment and embedded credentials. This can discard state needed by the application. Screenshots are optional and masked on a best-effort basis; timing may reflect additional rendering after an action.
- Redaction is heuristic. Less recognizable secrets, labels, custom text, screenshots, logs and exported code can still expose private data. Prefer synthetic data and review before sharing.
- Observed behavior does not establish correctness. Exact business expectations must come from the tester. A negative case needs assertions for the expected rejection; its label alone changes nothing about pass/fail semantics.

## Libraries, context and generation

| Boundary | Current limit |
| --- | --- |
| Project library | 500 cases; 1–20 distinct enabled cases per generation batch |
| Generation history | Latest 100 records, not a complete revision/audit log |
| Per scenario | 500 events, 30 assertions, 2,000 network entries |
| Suite import file | At most 5,000,000 bytes at the file boundary; structural validator additionally caps serialized data at 5 MiB |
| Module snapshot | 8,000 included files; depth 16; 20,000,000 bytes per file; 250,000,000 bytes total |
| Cached context | Up to 30 files after explicit addition; 10,000 characters per file; added files at most 500,000 bytes |
| Outgoing source context | Up to 30 excerpts and 150,000 source characters; whole prompt at most 300,000 UTF-8 bytes |
| Agent generation | 30–1,800 seconds per case; Claude cap $0.01–$20 per case |
| Generated code | 1–12 files per provider result, 150,000 characters per file; combined batch at most 100 files and 5,000,000 code characters |

Limits can reject work before a full generation completes. Smaller cases and a focused test module are usually more useful than raising every budget.

Project inspection detects npm/Maven/Gradle and framework clues heuristically. It caches selected tests, helpers and configuration at connection time; explicit additions are also cached. It does not ingest or continuously index the whole repository. Reconnect to refresh inspection and re-add files as needed. Excluded or truncated context is not evidence that a helper or requirement does not exist.

Libraries survive switching between the same canonical project folders. Moving a project changes its library key; use suite export/import. Raw recordings remain after case deletion, and history pruning does not clean old run folders. There is no automatic disk-retention policy, cloud synchronization or full edit-version history.

Portable generation covers supported Playwright TypeScript and Playwright Java/JUnit 5 templates. It does not interpret custom instructions, reuse arbitrary page objects, or implement custom assertions. Detection of Selenium, Maven or Gradle does not establish complete adaptation. AI output can be incorrect or incomplete despite valid JSON. Review every requirement, locator, fixture and import.

Codex and Claude use installed CLIs and the user's account configuration. Model/effort support, availability, usage limits and provider behavior can change. Time and Claude spend caps apply per case; a batch is not one capped request. Cancellation cannot reverse usage already incurred. Upstream documentation or CLI availability does not validate Testloom's live integration.

## Execution and evidence

A source copy keeps app-generated writes away from the connected original, but **is not an OS sandbox**. Installation, tests, plugins, subprocesses and browser actions run with local user permissions. They can modify outside files, contact services or change remote state. Use trusted projects and disposable data where appropriate.

Copies omit dependencies, build output, symlinks and recognizable credential files. Large modules, omitted configuration or symlink-based layouts need a smaller module or manual setup. Snapshot content is not comprehensively redacted. Prompt exclusions only filter outgoing source excerpts; they do not filter every artifact or restrict executed commands. A live folder copy is not an atomic snapshot of concurrent source edits.

The recommended Playwright JSON-report check requires every reported spec and project variant in each generated file to pass once, with no reported errors or interruptions. It rejects missing/empty files, skips, expected failures and retries. It cannot independently enumerate unreported declarations, prove assertion completeness or protect against a malicious trusted runner. Java and custom commands have no equivalent built-in discovery adapter. Check their actual test names and assertions yourself. Missing tests, skips, environment failures, cancellation and timeouts are not semantic passes or defect-detection evidence.

Generated-file hashes bind evidence to proposed test bytes. They do not cover every dependency or external service. Repeated passes support only those runs; they do not establish zero flakiness, comprehensive regression coverage, accessibility, security or cross-browser correctness. An environment diagnosis is heuristic and can need manual correction.

Bundles can include scenario text, screenshots, command output and generation settings/instructions. Suite-only export has a narrower public shape but still needs privacy review. No encryption-at-rest, provider retention guarantee or independent security certification is implied.

## The cart is a fixture

The cart uses USD, $40/$60 products, integer-cent arithmetic, a 10% coupon and quantities from 0 to 99. It has no real checkout, payments, tax, shipping, inventory or production authentication. Cookie sessions are shared within a browser context and reset on server restart or after two hours of inactivity. Session-cookie restoration depends on the browser.

The desktop demo selects an available loopback port and updates its copied configuration; use the URL shown in the app. The standalone cart still defaults to port 4318. `JOURNEYPROOF_BROKEN_DISCOUNT=1` deliberately applies 5% instead of 10%, producing $95.00 instead of $90.00. The baseline smoke test intentionally misses this defect. A generated coupon test must reach and fail its unchanged exact-value assertion to establish detection.

CI does not by itself establish native desktop behavior, live provider success, packaged distribution or compatibility with other Macs. Use [Getting started](GETTING-STARTED.md) for the first module and [Roadmap](ROADMAP.md) for broader rollout criteria.
