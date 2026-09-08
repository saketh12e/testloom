# Record a remote website

Testloom accepts direct **HTTP and HTTPS** page addresses, including hosted QA/staging/production applications. Connect your **local test project folder**, then enter the website address in Start recording. The project does not have to serve the website on localhost.

## Browser and login

Recording opens a separate browser context. Your existing Chrome or Edge login is not copied. If the site redirects to sign-in, complete your normal login inside the recording browser, then continue to the page you intend to test. Connect to a required company VPN first.

Testloom tries its matching Playwright Chromium, installed Google Chrome, then Microsoft Edge. On Mac, standard per-user Chrome and Edge installations are also supported. All fallbacks use a fresh context. If no browser is available, install Chrome/Edge or install Testloom's matching Chromium once:

```sh
npx playwright@1.63.0 install chromium
```

The command needs Node.js and internet access. Installing a different Playwright version's browser may not install the revision this app needs. Installing Chromium does not solve a certificate, DNS, proxy or access-policy problem.

Use a direct page address without a query or fragment. Starting URLs with embedded credentials are rejected. Query/fragment values on subsequent navigation are removed from the evidence; state-dependent or hash-route replay may need explicit repository fixtures and agent review.

## Startup errors in 0.3.1

The old app displayed the same “check URL/install Chromium” message for every failure. That did not establish that the URL was invalid. The patch reports separate guidance for:

- Missing browser or browser launch/permission failures.
- DNS, VPN, connection and proxy failures.
- HTTPS certificate failures. Certificate verification remains enabled.
- Redirect loops, device-policy blocks and navigation timeouts.

Raw browser error messages are not displayed because they can contain private paths, page text or authentication URL parameters. A page that responds but has slow scripts remains open with a loading notice. HTTP 4xx/5xx responses stay visible with a warning, allowing an expected negative response to be recorded. Neither condition counts as a passing test.

## Authentication in generated tests

Recorded login inputs are redacted; recordings are not reusable authentication files. Codex/Claude must use an appropriate existing test fixture or clearly report the missing setup. Portable generation cannot replay redacted credentials. Configure safe test accounts, authentication fixtures, dependencies and services in the copied test project before explicitly choosing Verify. A browser recording does not establish authenticated test replay.

If startup still fails, report the **complete new error text**, Testloom version, whether Chrome/Edge opens normally and whether a VPN is required. Do not send passwords, cookies, access tokens or private browser profiles.

The real external HTTPS startup check reached a sign-in page without submitting any forms. See [validation](VALIDATION.md) for the exact scope. Playwright documents [navigation readiness](https://playwright.dev/docs/api/class-page#page-goto) and [separate authentication state](https://playwright.dev/docs/auth).
