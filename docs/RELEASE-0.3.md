# Testloom 0.3.0 — native case sessions and large repositories

Generate now sends the current case's ordered recording ledger, explicit expectations and captured screenshots into a dedicated native Codex or Claude Code conversation. The agent can inspect relevant source, fixtures and backend code in a separate repository copy. Review the proposed files before choosing Verify; generation does not modify your connected source or run project commands.

## Changes

- Native Codex App Server sessions and persistent Claude Code sessions, separated by project, case and provider. Regenerating resumes the case's history, including after restart. A visible reset starts a fresh conversation next time.
- Screenshots are attached as native image inputs with event labels. Missing, unsafe or oversized evidence stops generation instead of silently dropping images.
- Maximum reasoning by default: Codex selects its model's advertised maximum; Claude receives `--effort max`. Existing explicit saved choices remain respected.
- The 8,000-source-file ceiling is removed. Concurrent scanning, progress, cancellation and bounded copying support large folders without putting every file into the prompt. The measured fixture contains 100,000 source files plus its manifest.
- Both agents get read-only, bounded source listing, path search, reading and text search. Unrelated shell and external tool integrations are disabled for Testloom's generation sessions.
- New session controls, repository counts and a clear notice explaining the evidence sent before Generate. Reconnecting a folder preserves session ownership; late cancellation cannot switch projects.

## Evidence

112 regression tests, formatting, types and production build passed. The packaged Mac app passed the 500-case desktop workflow with recording, generation, repeated verification and export, with zero renderer errors. Live Codex checks cover native screenshots, backend reads, two-turn memory and positive/negative generation: healthy passes followed by the same test detecting the disclosed discount defect. Original source stayed unchanged.

The 100,000-source-file fixture scanned in **166 ms**, copied and hashed in **22.72 seconds**, and peaked at **166.28 MiB RSS**. It contains tiny synthetic files totaling 3.28 MB, uses streaming fallback, and is not a general production-repository speed claim. See [the measured scope](LARGE-REPOSITORIES.md) and [validation record](VALIDATION.md).

## Install and limits

Download **Testloom-0.3.0-mac-arm64.zip**, check its SHA-256 against **TESTLOOM-0.3.0-SHA256SUMS.txt**, quit Testloom and move the extracted app into Applications. Existing case data is retained. Follow [Mac opening help](MAC-OPENING.md) for the previous damaged-app alert and per-app approval.

The app and extracted ZIP pass ad-hoc signature checks. This Apple Silicon preview is **not Developer ID signed or notarized**; a recipient Mac may still require approval. Intel Macs must build from source.

Claude's native session initialized, but this Mac's configured API returned **HTTP 401**. Its deterministic adapter and packaged MCP checks passed; successful live Claude generation remains unverified. Use an authenticated supported account and report its live check separately. Native CLI sessions are not a promise of browser-chat visibility or unlimited model memory.

Verification is a separate action and runs trusted project commands with your Mac permissions. The source copy does not sandbox services, browser actions or project scripts. Generated assertions and backend assumptions still need review.
