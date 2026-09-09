# Testloom 0.4.0 — a recording browser included with the Mac app

The previous release could stop after an installed browser crashed without trying a healthy Chrome or Edge. It also depended on a browser cache that existed on the developer's Mac but was not delivered in the ZIP. Chrome being installed did not guarantee that Testloom reached it. A screenshot of a closed browser does not establish the underlying process exit cause.

## What changed

- Each Mac ZIP includes the full Chromium distribution matched to the pinned Playwright version and its processor architecture. Recording a hosted website needs no Node, npm, terminal command or separate browser download.
- Startup checks the bundled browser, opens an isolated blank page and checks the page protocol before navigating to the requested website. Failed owned sessions are closed. Missing, crashed and unresponsive browsers can fall back to installed Chrome or Edge; explicit administrator restrictions stop recovery. Each candidate is tried once, with bounded launch/readiness timeouts. Customer URLs are not replayed by recovery.
- Browser child processes exclude inherited Electron/Node injection and dynamic-library injection variables. Normal OS, proxy and certificate settings remain available. HTTPS verification stays on. Daily browser profiles and logins are not imported.
- Startup progress is visible and Cancel works during preparation. Cancelling a process still in launch waits for its bounded launch to settle and close safely.
- A validated startup report persists across app restarts and can be exported from a failed recording dialog or Help. It contains app/browser/OS versions, process architecture, attempted browsers, failure categories and any available exit code/signal. No URL, recording, raw browser log, environment dump or personal file path is exported.
- Packaging checks complete browser resources, executable architecture, pinned dependency versions and sealed app signatures before archiving and after extraction. CI runs separate native Apple Silicon and Intel jobs, including actual recording from the ZIP with an empty browser cache and no Node on the app's PATH.

- Native Intel validation also exposed quadratic scanning of large agent responses. The output reader now scans newly decoded text once while preserving its existing byte limits.

## Install

Use macOS 14 or later. Choose **mac-arm64** for Apple Silicon (M-series) or **mac-x64** for Intel. Quit the old app, extract the matching ZIP and replace Testloom.app in Applications. Existing cases remain in Application Support. The included browser increases download size.

This is still an ad-hoc signed developer preview, without Apple Developer ID notarization. Managed Macs may require administrator approval. A company VPN, trusted certificate, supported OS or permission to automate cannot be supplied or bypassed by the app. See [Mac installation](MAC-OPENING.md).

The bundled browser is for recording. Running project tests and the cart demo still requires the project's runtime, dependencies and test browser. Codex/Claude still require their separate CLI setup and authentication.

See [validation](VALIDATION.md) for checks actually completed for this release, and [remote websites](REMOTE-WEBSITES.md) for sign-in and recording behavior.
