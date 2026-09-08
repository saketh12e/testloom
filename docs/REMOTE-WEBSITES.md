# Record a remote website

Testloom accepts direct **HTTP and HTTPS** page addresses, including hosted QA/staging/production applications. Connect your **local test project folder**, then enter the website address in Start recording. The project does not have to serve the website on localhost.

## Browser and login

Recording opens a separate browser context. Your existing Chrome or Edge login is not copied. If the site redirects to sign-in, complete your normal login inside the recording browser, then continue to the page you intend to test. Connect to a required company VPN first.

The v0.4.0 Mac download includes a matching recording browser. It checks that browser on a blank page before opening your address, then falls back to installed Chrome or Edge if a browser is missing, crashes or cannot become ready. Mac per-user installations are supported. Every attempt owns a fresh context; explicit administrator restrictions stop recovery. No customer page is replayed by startup fallback.

For source development only, install the pinned browser with `npm run browsers`. The packaged recorder needs neither Node nor a separate browser installation. Project test execution has separate dependencies.

Use a direct page address without a query or fragment. Starting URLs with embedded credentials are rejected. Query/fragment values on subsequent navigation are removed from the evidence; state-dependent or hash-route replay may need explicit repository fixtures and agent review.

## Startup errors and reports

The old app displayed the same “check URL/install Chromium” message for every failure. That did not establish that the URL was invalid. The patch reports separate guidance for:

- Missing browser or browser launch/permission failures.
- DNS, VPN, connection and proxy failures.
- HTTPS certificate failures. Certificate verification remains enabled.
- Redirect loops, device-policy blocks and navigation timeouts.

Raw browser error messages are not displayed because they can contain private paths, page text or authentication URL parameters. A page that responds but has slow scripts remains open with a loading notice. HTTP 4xx/5xx responses stay visible with a warning, allowing an expected negative response to be recorded. Neither condition counts as a passing test.

## Authentication in generated tests

Recorded login inputs are redacted; recordings are not reusable authentication files. Codex/Claude must use an appropriate existing test fixture or clearly report the missing setup. Portable generation cannot replay redacted credentials. Configure safe test accounts, authentication fixtures, dependencies and services in the copied test project before explicitly choosing Verify. A browser recording does not establish authenticated test replay.

If startup still fails, choose **Export startup report** in the recording dialog, or **Help → Export browser startup report**. The report identifies attempted browsers, system and app versions, failure categories and available exit codes/signals. It contains no URLs, recordings, environment dump, raw browser logs or personal file paths. A missing signal means the browser did not provide one; it does not establish a policy restriction. Do not send passwords, cookies, tokens or browser profiles.

The real external HTTPS startup check reached a sign-in page without submitting any forms. See [validation](VALIDATION.md) for the exact scope. Playwright documents [navigation readiness](https://playwright.dev/docs/api/class-page#page-goto) and [separate authentication state](https://playwright.dev/docs/auth).
