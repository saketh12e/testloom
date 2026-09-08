# Release validation

## 0.3.1 remote recording startup — 2026-09-08

- Formatting, type checking, production build and **140 regression tests passed**.
- The **packaged app** opened and stopped recordings for both the reported external HTTPS root address and its nested connector page. Both redirected to the sign-in page and saved a navigation case with redirect guidance. No website clicks, login, form submissions or protected operations were performed. Original test-project bytes remained unchanged; there were no renderer errors. Private endpoint details remain in local working evidence rather than the public source archive.
- With an explicitly empty Playwright browser cache and no installed Chrome/Edge, the packaged app displayed the version-matched browser-installation message, removed the internal IPC error prefix and returned to idle without creating a case. Chrome/Edge fallback selection is covered by deterministic launch tests; a live installed Chrome/Edge fallback could not be exercised on this Mac.
- Real-browser fixtures cover cross-origin HTTP redirects, synthetic HTTPS responses, slow script readiness, DNS navigation failures, HTTP 403 responses and cancellation. A service regression preserves both owned-demo loopback aliases and ensures remote URLs do not start the local demo server.
- The packaged app passed the existing desktop workflow: **500 saved cases**, selected generation, recording, repeated verification and export, with zero renderer errors. Its app and ZIP extraction passed the ad-hoc signature gates.

The friend's original screenshot showed the old generic startup error. That message erased the underlying cause, so this release does not claim to identify or repair the friend's VPN, certificates or browser installation remotely. The supplied address is accepted and recordable on the validation Mac; authenticated test replay remains unverified. [Remote website setup](REMOTE-WEBSITES.md) explains the remaining requirements.

Reproduce the opt-in packaged startup check using an address you are authorized to open:

```sh
TESTLOOM_REMOTE_URL=https://your-app.example.com \
TESTLOOM_EXECUTABLE="$PWD/release/mac-arm64/Testloom.app/Contents/MacOS/Testloom" \
npx tsx tests/remote-url.integration.ts
```

## 0.3.0 native sessions and large repositories — 2026-09-08

Checked with Codex CLI **0.153.4**, Claude Code CLI **2.1.116**, Electron **44.2.0** and Node **22.22.3** on an Apple Silicon Mac. Results below distinguish deterministic checks, live model behavior and packaged runtime checks.

| Check | Observed result |
| --- | --- |
| `npm run check` | Formatting, type checking, **112 regression tests**, and production build passed. |
| Packaged desktop workflow | **500 saved cases**, three-case generation, recording, repeated verification and export passed, with **zero renderer errors**. Maximum effort was the fresh default and persisted through the Claude settings UI. |
| Live Codex session | Two turns in the **same native session across separate adapter invocations**. Codex read an unpredictable backend value through repository tools, recognized an unpredictable value present only in a screenshot, and recalled prior text/image values on resume without reattachment. It also read an updated backend value. The advertised maximum was **`ultra`**. Source bytes unchanged. |
| Recorded journey and Portable suite | Both v0.3 integrations passed two healthy runs and caught the deliberate discount defect with unchanged tests and original source. The journey check independently hashes original and copied bytes using the new manifest format. |
| Live Codex test generation | Positive and negative coupon tests were discovered and passed **two healthy runs**. The unchanged positive test detected the deliberate **$90.00 expected / $95.00 received** discount defect. Original source unchanged. |
| Claude adapter | Native session creation with maximum effort and image input was observed. The configured API returned **HTTP 401**; no generated file, successful live repository grounding or image understanding is claimed. Authentication and routing were not changed. Deterministic session, image, MCP, cancellation and response tests passed. |
| Large-repository fixture | **100,000 actual tiny TypeScript files plus package.json**: inspect **166 ms**, copy/hash including fresh scan **22,716 ms**, peak process RSS **166.28 MiB**. All 100,001 copies independently checked; expected manifest digest matched. Streaming fallback exercised; native cloning unavailable. [Full scope](LARGE-REPOSITORIES.md) and [sanitized measurement record](benchmarks/repository-100000.json). |
| Packaged Claude repository server | The released app's Electron Node runtime loaded the server from `app.asar`, completed MCP initialization, listed all four tools and successfully read fixture source. This is runtime/tool evidence, not a successful Claude API response. |
| Mac ZIP integrity | Ad-hoc signatures passed deep/strict verification on the bundle and again after ZIP extraction. Developer ID signing, notarization and a clean recipient-Mac install remain unverified. |

New regressions cover native session ownership, restart and folder reconnect, per-case/provider separation, reset and exclusion changes, late scan cancellation, stale turn rejection, read-only repository tools, source/screenshot path checks, bounded pagination and streaming, and source-preserving snapshots. The public service workflow verifies that Generate does not automatically start test execution or modify original source.

Reproduce the additional checks:

```sh
npx tsx tests/repository-scale.integration.ts
TESTLOOM_LIVE_SESSION=codex npx tsx tests/session.integration.ts
TESTLOOM_AGENT=codex npx tsx tests/agent.integration.ts
```

The large-file-count fixture is synthetic and has only 3.28 MB of content; it does not establish performance on a 50 GB production repository. Live checks consume account usage. Java compilation evidence below belongs to v0.2; it was not rerun for this release. The v0.3 desktop checks exercise Portable generation, while the separate live checks exercise Codex. No successful live Claude generation is claimed.

## 0.2.1 packaging repair — 2026-09-07

The v0.2.0 app failed `codesign --verify --deep --strict`: **code has no resources but signature indicates they must be present**. A recipient reported macOS's damaged-app alert. The earlier local app workflow did not test downloaded-app trust.

For v0.2.1, the complete app bundle and nested code receive an ad-hoc signature with hardened runtime and the required Electron JIT/library entitlements. Verification passes before archiving and again on the app extracted from the release ZIP. The regression fixture rejects both an incomplete bundle signature and a changed sealed resource, including inside a ZIP.

- **84 regression tests**, formatting, type checking and production build passed.
- The rebuilt **packaged app passed the full desktop workflow**: 500 saved cases, three-case generation, repeated verification, recording and export, with zero renderer errors.
- `codesign --verify --deep --strict` reports **valid on disk / satisfies its Designated Requirement**.
- `spctl --assess --type execute` still reports **rejected**. This is not Developer ID signing or notarization. No valid signing identity was available on this Mac, and opening the quarantined download on a separate recipient Mac has not been verified.
- CI now builds a Mac ZIP and runs the signature hooks. See [Mac installation help](MAC-OPENING.md) for the remaining per-app approval requirement.

The previous version's functional evidence follows; live Codex and Java generation were not rerun for this packaging-only repair.

## 0.2.0 functional validation

Checked on **2026-09-07**, on **macOS 26.5.1 / Apple Silicon**. Electron **44.2.0**; Node **22.22.3**; Playwright TypeScript **1.63.0**; Playwright Java **1.62.0**; Temurin **17.0.20.1**; Maven **3.9.16**. Codex CLI **0.153.4**; Claude Code CLI **2.1.116**.

## Results

| Check | Observed result |
| --- | --- |
| `npm run check` | Formatting, TypeScript, **83 regression tests**, and the production build passed. |
| `npm run test:suite` | Positive, negative, and boundary cases passed **2 healthy runs**. The unchanged positive test failed on the deliberate 5% discount defect: **$90.00 expected / $95.00 received**. Source unchanged. |
| `npx tsx tests/batch.integration.ts` | **20 generated files / 20 discovered and passing tests** in one selected batch. |
| `TESTLOOM_AGENT=codex npx tsx tests/agent.integration.ts` | The actual Codex CLI authored positive and negative cases. Both were discovered and passed **2 healthy runs**; the unchanged positive test detected the discount mutation. All explicit requirement IDs were retained. Original source digest unchanged. |
| `npx tsx tests/java.integration.ts` with the documented JDK/Maven environment | A real browser recording plus negative/boundary examples compiled into **3 Java/JUnit tests**. All passed on the healthy cart; the unchanged positive test failed on $90.00 versus $95.00. The shipped Java dependency version was used. Original Java and cart source digests unchanged. |
| `npm run test:desktop` | Real Electron UI: edit an expired-coupon variant, duplicate it, save Claude controls, preview the prompt, select/generate 3 cases, verify twice, and export matching test bytes and verification hashes. Then record a fresh 5-event journey, author its requirement, generate and verify twice. Import **500 total cases**, search, and confirm the **20-case selection cap**. **Zero renderer errors.** |
| Packaged app | **Passed the same real desktop workflow against the packaged `.app`**: 500 cases, editing, generation, verification, import/export, recording, and zero renderer errors. |
| Existing Mac upgrade | The rebuilt app reopened the existing v1 session with all **12 actions and original requirements preserved**, one migrated case, the new output path, and no startup error. Workspace aliases are compared by directory identity. |
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

These tests cover the stated sample behaviors, protocol boundaries, and demonstrated library/batch sizes. They do not establish complete business-rule coverage, universal project compatibility, clean-Mac installation, or a successful live Claude call. Maven/custom commands currently have weaker automatic discovery assurance than the recommended Playwright JSON command; the Java validation above inspects actual Maven/Surefire results. The distributed app is **ad-hoc signed and unnotarized**, without Developer ID trust.

## 0.4.0 browser runtime release checks

- Local `npm run check`: 174 tests passed, TypeScript and formatting passed, production build passed. Includes crash-to-healthy-browser recovery, readiness failure cleanup, cancellation, explicit policy stopping, first-line missing-browser classification, environment isolation, strict report privacy/restoration, bundle path/version/architecture validation and signature/resource rejection.
- The Apple Silicon ZIP includes the full pinned Chromium app (349 files and 17 Mach-O binaries at preparation) and passes deep/strict signing verification before archiving and after extraction.
- `npm run test:packaged` extracts the real release ZIP to a path containing spaces, starts with fresh app data, an empty Playwright cache and no Node on the app's PATH, records a synthetic website exactly once, saves the case, exports/restores the safe startup report and checks the connected source is unchanged. It also checks unavailable-site error export and startup cancellation.
- `.github/workflows/ci.yml` runs all checks, builds the full ZIP, verifies its browser payload and records from it on separate native macOS 14 ARM and macOS 15 Intel runners. Verified ZIPs are retained as workflow artifacts. Consult the release's exact commit and CI result for completed native-platform evidence; a local cross-build is not a physical Intel validation.

The old screenshot cannot reveal the original process exit cause. These checks establish repair of identified startup/release defects, not operation under every device policy, OS version or network configuration. Real Chrome/Edge fallback selection is covered with fault-injected launch tests; the clean-install gate requires the included Testloom Chromium to be the successful browser. There is still no Developer ID notarization.
