# Getting started with Testloom

Testloom v0.3.0 is an ad-hoc signed Apple Silicon developer preview without Apple notarization. Start with the synthetic cart before connecting a trusted project. You need **Node.js 20.19+**, npm and Chromium for this walkthrough.

## Install and launch

From the repository root:

```sh
npm ci
npm run browsers
npm start
```

For a downloaded app, use the v0.3.0 Apple Silicon asset in [Releases](https://github.com/saketh12e/testloom/releases/tag/v0.3.0). Replace the v0.2.0 app, which had an incomplete bundle signature. Follow [Mac installation help](MAC-OPENING.md) for checksum verification and opening a trusted preview. The new signature is not Apple Developer ID signing or notarization. [Migration](MIGRATION.md) explains existing JourneyProof installations.

For the downloaded app, install Node.js 20.19+ and its recording/test browser once:

```sh
npx playwright@1.63.0 install chromium
```

Portable generation needs no AI account. Codex is the primary agent option; install its [official CLI](https://developers.openai.com/codex/cli), check `codex --version`, and run `codex login`. For Claude, install and authenticate the official Claude Code CLI and check `claude --version`. Refresh agent availability after setup. Availability means the executable responds, not that account access or generation has been validated. See [agent setup and controls](AGENTS.md).

## Case sessions and large repositories

Generate creates or resumes a dedicated native session for each selected case and provider. Captured screenshots are attached alongside the ledger and written expectations. The agent can inspect the isolated source copy through read-only tools and returns proposed files for review. It cannot edit the original project. Agent settings shows the session ID, turns, reset control and repository file count. **Maximum** reasoning is the new default; saved lower choices remain respected. See [large repositories and sessions](LARGE-REPOSITORIES.md) for measured 100,000-file support and memory boundaries.

## Run the three sample cases

1. Open **Try the cart demo**. Testloom creates a local copy and starts the cart on an available loopback port. Use the active case URL shown in the app; the copied Playwright configuration uses that same port.
2. Review the three hand-authored examples in the case library. They are fixtures, not recordings of your session.
3. Select all three enabled cases and choose **Portable** generation. The app processes selected cases sequentially in one source copy, with a separate output folder per case.
4. Review the generated files and patch. Confirm that each test performs both add actions, enters its coupon value and checks the expected result below.
5. Run **Generated tests · confirm discovery**. For the demo, Testloom installs pinned test dependencies with `--ignore-scripts` and stops its own server so the test runner starts a fresh one. Review the actual results and discovery evidence.

| Case | Coupon input | Required total | Required feedback |
| --- | --- | --- | --- |
| Positive | `SAVE10` | `$90.00` | Ten percent off the $100.00 cart |
| Negative | `INVALID` | `$100.00` | `Coupon INVALID is invalid. No discount applied.` |
| Boundary | Empty string | `$100.00` | `Enter a coupon code. No discount applied.` |

**All three should pass on the healthy cart.** A negative case asserts correct rejection. The kind label does not invert the result, alter an input, add an assertion, or enable the runner's expected-failure mode.

## Record and edit your own case

1. With the demo open, name a new recording **Save ten on essentials** and use its loopback URL. Start recording before interacting with the browser Testloom opens.
2. Add the **$40 Field notebook** and **$60 Canvas bag**. Enter **SAVE10** in **Coupon code** and click **Apply coupon**. Wait for the total.
3. Return to Testloom and stop recording. Review navigation, both add actions, the fill and the apply action. A saved case is created; the raw recording remains separate.
4. Add an explicit requirement: description **SAVE10 takes ten percent off the cart**, kind **text**, locator strategy **testId**, locator value **total**, expected text **$90.00**. Save the case. The observed total does not define the correct total.
5. Duplicate it as a negative or boundary case. Edit the coupon fill value and every affected assertion. Set tags, priority and enabled status, then save. Editing a case does not rewrite its raw recording.
6. Select 1–20 enabled cases. Choose Codex, Claude or Portable. For an agent, save your controls and inspect the selected case's prompt before generating. Review each case separately when a batch contains different data.
7. Inspect the proposed code and warnings, verify, and export. A changed case needs new generation and verification; old evidence is not evidence for the edit.

The library retains up to 500 cases for each connected project folder. Reopening that folder restores its library. History keeps the latest 100 generation records, with verification status updates; it is not a complete revision log or an automatic rerun system. [Suite format](SCENARIO-FORMAT.md) covers IDs and portability.

## Import, export and adopt

Open a project before importing a v2 suite JSON file. Import adds its cases to the library; conflicting case IDs are cloned into new variants. Review imported URLs, inputs, assertions and warnings before running anything. Imported screenshot paths are discarded.

**Export suite** saves the editable library without project paths, provider settings or screenshot references. This is the portable handoff for another Testloom installation; the receiver still supplies the app, dependencies, fixtures and services.

**Export results** creates an evidence bundle with the library (`suite.json`), active scenario (`scenario.json`), and, when generated, the batch's case snapshot (`generated-suite.json`), code, patch and generation metadata. Available verification and eligible screenshots are included separately. Review the whole bundle for sensitive data. Copy reviewed tests into your original repository yourself; Testloom does not apply the patch there.

## Verify the deliberate discount bug

Work in the **generated cart workspace** after installing its dependencies. Stop your own existing cart server so a healthy process cannot hide the mutation. Use the exact generated positive-case file path shown by Testloom, including its `case-<id>` folder:

```sh
TESTLOOM_CASE_FILE='tests/testloom/case-<id>/<generated-file>.spec.ts'
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=0 npm test -- "$TESTLOOM_CASE_FILE"
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=1 npm test -- "$TESTLOOM_CASE_FILE"
```

Replace both placeholders before running. Keep the generated test unchanged between runs. The expected evidence is a healthy pass followed by an assertion failure: **$90.00 expected, $95.00 received**. A port conflict, missing browser, timeout or missing test is not discount-detection evidence. The legacy environment-variable names remain intentional compatibility details.

The cart's `npm run test:contract` is a separate fixture check and cannot replace testing the app-generated file. The v0.2 suite checks passed all three healthy cases and detected the disclosed discount mutation. See [Validation](VALIDATION.md) for exact results.

## Connect your own project

Choose the test module folder, review the detected framework and example tests, and start its application using that project's setup. Use **Add context files** for relevant page objects, helpers or configuration; check **Preview prompt** to see what fits. Excerpts are cached at connection/addition, so reconnect to refresh them and re-add specific files as needed. Your saved project cases survive folder switching. Record the reachable app URL. Review agent context, add expected results, generate and inspect the copied workspace. Supply that project's dependencies, services and safe test data in the copy.

Inspection is heuristic: npm/Maven/Gradle detection and Selenium clues do not establish universal compatibility. Portable targets are Playwright TypeScript and Playwright Java/JUnit 5; see the [Java example](../examples/java/README.md). Custom assertions and unsupported recording steps need an agent proposal or manual implementation and review.

Snapshot defaults allow up to 1,000,000 included files, 2 GiB per file and 50 GiB total, with depth 64. A 100,000-source-file synthetic fixture has been measured; these larger ceilings are not a performance guarantee. See [large repositories](LARGE-REPOSITORIES.md) for progress, cancellation and benchmark scope. Exclusions can remove needed dependencies or configuration. The copy is not an OS sandbox: execute only project commands you trust.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Missing Chromium | Run `npm run browsers` in the relevant project. The recorder may fall back to installed Google Chrome; the test runner may still need its pinned Chromium. |
| Demo/server startup fails | The desktop demo chooses an available port; use its displayed URL. The standalone cart defaults to 4318 and accepts `PORT`. Inspect the error and stop only a server you own. |
| Agent unavailable or generation rejected | Check CLI installation, login, model and account access; refresh availability. Try one small case or Portable for supported templates. |
| Timeout or Claude budget exhausted | Inspect the error, simplify the case or revise its budget within the supported bounds. No passing test is claimed. |
| Import rejected | Check the [v2 schema](../schemas/scenario-v2.schema.json), IDs, URLs and 500-case combined library limit. Keep the file below 5,000,000 bytes. |
| Recorded input is redacted | Use synthetic data or an existing safe fixture. Do not add real credentials to the case. |
| Only a baseline test ran | Use the generated-files command and inspect discovery evidence. Confirm Java/custom runner discovery manually. |
| Generated bytes changed on disk | Generate a new proposal before verification or export; evidence is bound to the proposed bytes. |
| Save failed | Check disk space and export the suite before closing. Persistence errors must not be treated as saved changes. |
| A moved project has an empty library | Libraries are keyed by canonical folder path. Export from the old location and import into the new one. |

See [limitations](LIMITATIONS.md) before using company projects or sensitive data.
