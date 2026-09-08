# Testloom 0.3.1 — remote recording startup

The recording dialog previously hid browser, certificate, DNS, proxy and navigation failures behind the same “check URL/install Chromium” error. The patch distinguishes these failures and gives a relevant next step without displaying raw URL tokens or private browser diagnostics.

- Remote HTTP/HTTPS websites are clearly supported in the recording form. A fresh-browser and VPN/login explanation appears before recording.
- Missing Playwright Chromium falls back to installed Chrome or Edge, including their standard per-user Mac installations. The missing-browser message gives the exact Playwright version to install. Installed-browser crashes are reported rather than treated as missing executables.
- A page that responds but has slow scripts stays open with a loading notice. HTTP error responses and sign-in redirects receive separate guidance; they are not reported as successful test outcomes.
- Remote recordings no longer depend on starting the local cart demo server.
- The UI removes Electron's internal IPC prefix from errors.

## Validation and scope

The supplied external HTTPS address was checked through the real recorder and redirected to sign-in. No login, form submission or protected application operation was performed. The friend's original screenshot contained the old generic error, which cannot identify that Mac's underlying cause; the patch makes the next failure actionable.

Deterministic browser checks cover cross-origin login redirects, safe HTTPS input, slow script readiness, DNS failures, HTTP 403 responses, browser fallback and cancellation. Full results are in [Validation](VALIDATION.md). Authenticated workflows still require working access and repository test fixtures; recording does not import an existing browser login.

Download **Testloom-0.3.1-mac-arm64.zip** and follow [Mac opening help](MAC-OPENING.md). This is an ad-hoc signed Apple Silicon preview, without Developer ID signing or notarization. Claude's previously documented live authentication limitation remains unchanged.
