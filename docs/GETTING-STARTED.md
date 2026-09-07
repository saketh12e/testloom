# Getting started

JourneyProof 0.1 is a Mac developer preview. Use Node.js **20.19 or later**, npm, and a trusted local project. Download the Apple Silicon app from [Releases](https://github.com/saketh12e/journeyproof/releases/tag/v0.1.0), or build from source below. The app is not Apple Developer signed or notarized; macOS may require **System Settings → Privacy & Security → Open Anyway**. Keep system-wide security protections enabled.

## Install and launch

From the JourneyProof repository root:

```sh
npm ci
npm run browsers
npm start
```

For Codex mode, install the [official Codex CLI](https://developers.openai.com/codex/cli), ensure `codex --version` works, and run `codex login` to sign in. Restart JourneyProof if you installed the CLI after opening the app. JourneyProof collects no API key. Calls use your CLI and Codex account; account access, available models, and usage limits apply. Portable mode needs no Codex login or model call.

## Record the full cart flow

1. Load the bundled cart demo. The desktop app's `loadDemo` operation owns copying `examples/cart` into its working area and starting `server.mjs`. The default address is **http://127.0.0.1:4318**. If using the standalone sample instead, follow its [README](../examples/cart/README.md) and choose that folder as your project.
2. Name the scenario **Save ten on essentials** and set that address as the start URL. Start recording **before** interacting with the cart. Use the browser opened by JourneyProof. A fresh browser session starts empty; use **Reset cart** if needed and include that reset in the recording.
3. Click **Add Field notebook to cart** ($40.00), then **Add Canvas bag to cart** ($60.00). The subtotal is **$100.00**.
4. Enter **SAVE10** in **Coupon code**, then click **Apply coupon**. Wait for the total to show **$90.00**.
5. **Stop recording** in JourneyProof. Review the captured navigation, both add actions, coupon fill, and apply action. The observed total is evidence of what happened, not yet your requirement.
6. Review the prefilled assertion or add your own: description **SAVE10 takes ten percent off the cart**, kind **text**, locator strategy **testId**, locator value **total**, and expected text **$90.00**. Save the scenario. Do not accept $95.00 because a broken app displayed it.
7. Generate with **Portable** mode for the deterministic TypeScript path. The output belongs at **`tests/journeyproof/<slug>.spec.ts`** in the generated workspace. Codex mode can instead adapt to the selected repository's test conventions; review its output and warnings.
8. Inspect the generated file and patch. The test must perform the whole journey and include an exact text check equivalent to `await expect(page.getByTestId('total')).toHaveText('$90.00')`. Check the start URL and port as well as the assertion.
9. Use the recommended **Generated tests · confirm discovery** command. It targets the generated Playwright files, disables retries, and requires a JSON report confirming actual passing test discovery. The app prepares dependencies automatically for the demo only, using `--ignore-scripts`, and stops its demo server before running tests. The original project command is also available; custom commands have weaker discovery guarantees and require inspecting the output yourself.
10. Review every run, its exit status, and warnings. Export the scenario, generated files/patch, and available verification evidence. Review the export for sensitive data before sharing it or copying the generated test into your original repository yourself.

The assertion uses the shared `Assertion` contract: `kind: 'text'`, `locator: { strategy: 'testId', value: 'total' }`, `expected: '$90.00'`, and `source: 'user'`. Recording and assertion authoring remain separate operations.

## Verify the deliberate discount bug

Do this in the **generated cart workspace**, where the generated file exists, after installing its dependencies with `npm ci`. Stop any app-managed or manually started cart server first so the test owns a fresh server. Do not change the generated test between the healthy and broken runs.

The generated basename includes the scenario slug and a short ID. Replace `12345678` below with the ID in your actual generated filename:

```sh
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=0 npm test -- tests/journeyproof/save-ten-on-essentials-12345678.spec.ts
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=1 npm test -- tests/journeyproof/save-ten-on-essentials-12345678.spec.ts
```

The intended result is a healthy pass followed by a failed exact-text assertion: expected **$90.00**, received **$95.00**. A port conflict, missing browser, timeout, or missing test is an environment problem, not evidence of discount detection. The config refuses server reuse when mutation mode or fresh-server mode is set. If a generated test hardcodes a different URL, align it with the server before running and keep that same test for both runs.

The fixture's `npm run test:contract` is a separate developer check, outside normal test discovery. It cannot substitute for running the app-generated test. Actual release checks are recorded in [Validation](VALIDATION.md).

## Use your own repository

Choose its test module folder, review the detected framework, example tests, and available commands, and start its application using its own documented setup. Record against the reachable app URL. Add requirements explicitly, then generate and inspect the resulting tests in the copy. Install dependencies and supply test data or services required by that project.

Repository inspection is heuristic. Playwright TypeScript is the bundled runnable path. Playwright Java is a portable-generation target; Maven/Gradle and Selenium Java adaptation require project-specific review and toolchains. See the [Java notes](../examples/java/README.md). Unknown frameworks and unsupported interactions need manual work.

Generation leaves the connected original untouched, but scripts run with local user rights. The copy is not an OS sandbox, and browser workflows can change remote state. Review any install and verification command before running trusted repository code.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| `npm ci` rejects the lockfile | Use a complete source checkout with matching package and lockfile; report the mismatch. |
| Chromium executable is missing | Run `npm run browsers` in the relevant project and use the same browser-cache environment when running tests. |
| Port 4318 is occupied | The built-in demo uses 4318. Stop your own server, or run the standalone sample with `PORT` set to a free port and connect its folder. Avoid terminating unrelated processes. |
| Codex is unavailable or not signed in | Check `codex --version`, run `codex login`, then restart the app; use Portable mode for supported templates. |
| Only the baseline test ran | Check the generated path and test discovery; run the generated filename explicitly. |
| Recorded credentials were redacted | Add safe fixtures or environment-backed setup manually; do not insert real secrets into the scenario. |
| Verification failed before reaching the assertion | Repair the dependency, server, authentication, or test-data setup and rerun; preserve the original evidence. |
| Generated test changed on disk | Generate a new proposal before verifying or exporting. Evidence is tied to the exact proposed test bytes. |
