# Contributing to Testloom

Small, reviewable contributions are welcome under the [MIT license](LICENSE). The repository is [saketh12e/testloom](https://github.com/saketh12e/testloom); its JourneyProof URL redirects here. Read the [architecture](docs/ARCHITECTURE.md), [suite contract](docs/SCENARIO-FORMAT.md) and [limitations](docs/LIMITATIONS.md) before changing behavior.

## Development

Use macOS and **Node.js 20.19+** for desktop work:

```sh
npm ci
npm run browsers
npm start
```

The root scripts are:

```sh
npm run typecheck
npm test
npm run build
npm run check
npm run test:journey
npm run test:suite
npm run test:desktop
```

`check` combines formatting, type checking, regression tests and the production build. The desktop check needs an interactive graphical Mac session. `npm run package:mac` builds and verifies an ad-hoc signed local app directory; `npm run dist:mac` also extracts and verifies the resulting ZIP. Neither command establishes Developer ID trust, notarization, clean-machine compatibility or publication. [Mac installation help](docs/MAC-OPENING.md) explains the signing boundary.

The independent cart fixture has its own lockfile:

```sh
cd examples/cart
npm ci
npm run browsers
npm test
npm run test:contract
```

Its baseline smoke and contract checks are separate from app-generated tests. For generation changes, follow the [healthy/mutated cart procedure](docs/GETTING-STARTED.md#verify-the-deliberate-discount-bug). Java setup is in the [Java example](examples/java/README.md).

Live provider checks require the corresponding authenticated CLI and consume its account usage:

```sh
TESTLOOM_AGENT=codex npx tsx tests/agent.integration.ts
TESTLOOM_AGENT=claude npx tsx tests/agent.integration.ts
```

Report each provider separately; a successful Codex check does not validate Claude. For native screenshot, repository-read and resumed-memory behavior, run `TESTLOOM_LIVE_SESSION=codex npx tsx tests/session.integration.ts`. The opt-in large-folder benchmark is `npx tsx tests/repository-scale.integration.ts`; it creates and removes 100,000 real source files and reports copy/hash time separately from fixture setup and verification.

## Change the contract with care

- Keep shared types, runtime validation, the [v2 schema](schemas/scenario-v2.schema.json), examples and docs consistent. A structurally valid draft need not be ready to generate.
- Keep raw recordings separate from editable cases. Duplication must preserve expectations until a user explicitly changes them. Case kind is metadata; negative cases assert correct rejection.
- Test library persistence and folder switching when changing storage. Exercise import bounds and IDs, case output collisions, disabled cases and selected-batch limits when changing suites.
- For provider changes, check bounded context and exclusions, exact preview construction, timeout/cancellation, terminal result parsing and malformed outputs. Local fake-CLI tests do not establish live provider success.
- Preserve `.journeyproof` metadata and legacy application identity unless a documented migration replaces them. New outputs use `testloom` paths and the portable Java package is `testloom`.

## Submit a pull request

Describe the concrete problem and resulting behavior. Include relevant commands, toolchain versions, outcomes and checks not run. For recorder/generator changes, include a sanitized scenario, generated diff, test names and execution evidence. Show a healthy control and the same test detecting the intended defect when that is the change's purpose. Do not label a timeout, provider error, missing test or skipped check as a pass.

CI checks types/build/regressions, the recorded-journey and suite fixtures and cart checks without provider credentials. It is not a live Codex/Claude validation, full native UI test or release publication. Use the version-specific [validation record](docs/VALIDATION.md) for release claims.

Keep credentials, private source, browser state, personal screenshots and local run workspaces out of contributions. Report vulnerabilities through [SECURITY.md](SECURITY.md). The [roadmap](docs/ROADMAP.md) identifies useful work and the evidence needed for it.
