# Limitations

JourneyProof 0.1 is a scoped developer preview for macOS. Source and an Apple Silicon app are provided. The app is not Apple Developer signed or notarized. [Validation](VALIDATION.md) records the actual checks; those checks do not establish universal framework support or production readiness for every repository.

## Recording and generation

- Supported DOM actions do not cover every browser interaction. Frames, file uploads, canvas gestures, multi-select controls, complex popups, downloads, dialogs, and shadow-DOM edge cases require review or manual work. Recording warnings must remain visible in the result.
- Authentication, CAPTCHA, MFA, expiring sessions, test data, and external services can prevent replay. A fresh browser context is not automatically authenticated. Secrets intentionally removed from a recording cannot be replayed without safe project-specific setup.
- URLs are normalized and sensitive fields are redacted. This can remove query/fragment state needed by an application. Screenshots, logs, custom text, and less recognizable secrets may still disclose private data; redaction is not comprehensive.
- Observed behavior does not define correctness. A user must add the expected outcome. Visibility of the total is weaker than the exact `$90.00` text assertion required by the cart example.
- Portable generation covers supported templates, with Playwright TypeScript demonstrated by the bundled runnable fixture and Playwright Java a separate target. Detection of Selenium Java, Maven, or Gradle does not establish complete adaptation. Unknown frameworks, custom assertions, fixtures, imports, and project conventions need review.
- Codex output may be incorrect, incomplete, or unsuitable for a repository even when it conforms to the output schema. Account availability, CLI configuration, model behavior, and service limits affect generation. Claude is not an implemented provider in the 0.1 build plan.

## Execution and evidence

- A snapshot leaves the original source out of app-generated writes but is **not an OS sandbox**. Installation and verification execute trusted repository scripts with local user rights. Scripts and browser workflows can modify outside files, contact services, or change remote state.
- The copy excludes selected dependencies, build outputs, credentials, and symlinks. Large projects, omitted dependencies, required configuration, or symlink-based layouts may need a smaller module or manual setup. Excluded filenames are not a guarantee that all copied content is safe to share.
- A successful process exit is meaningful only if the intended generated test actually ran and asserted the requirement. Missing tests, skipped tests, infrastructure errors, cancellation, and timeouts must not be described as semantic passes or mutation detection.
- Repeating a test increases evidence about those runs. It does not prove the absence of flakiness, race conditions, regressions outside the journey, accessibility issues, security flaws, or bugs in other browsers.
- Evidence exports can contain private source, screenshots, URLs, and command output. Review before sharing. No cloud upload, retention policy, or independent security certification is implied by an export feature.

## Bundled cart

The cart is a local USD fixture: $40.00 and $60.00 products, integer-cent arithmetic, a 10% coupon, explicit invalid/expired feedback, and quantities from 0 to 99. It omits tax, shipping, inventory, real checkout, persistent storage, and production authentication. Sessions are separated by browser cookies, shared by tabs in the same browser context, and cleared on server restart or two hours of inactivity. Browser session-cookie restoration is browser-dependent.

`JOURNEYPROOF_BROKEN_DISCOUNT=1` intentionally applies 5% instead of 10%, making the two-product total $95.00. This is a disclosed mutation fixture. The baseline smoke test intentionally misses it; the generated coupon assertion must detect it. Stop any existing server before a mutation run and confirm the failure reaches that assertion.

CI checks do not by themselves validate desktop interaction, Codex generation, release packaging, or behavior on every supported Mac. See [getting started](GETTING-STARTED.md) for the specific owner verification procedure.
