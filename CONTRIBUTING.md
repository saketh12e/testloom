# Contributing

JourneyProof welcomes small, reviewable contributions under the [MIT license](LICENSE). The planned public home is [saketh12e/journeyproof](https://github.com/saketh12e/journeyproof). Until publication, work from the supplied source checkout. Read the [build plan](docs/BUILD-PLAN.md), [architecture](docs/ARCHITECTURE.md), and [limitations](docs/LIMITATIONS.md) before changing a contract.

## Development

Use macOS and Node.js 20.19+ for desktop development. Install dependencies and Chromium, then open the app:

```sh
npm ci
npm run browsers
npm start
```

Use the scripts actually defined in the root package:

```sh
npm run typecheck
npm test
npm run build
# All three, in that order:
npm run check
```

`npm run package:mac` builds a local application directory; `npm run dist:mac` requests a ZIP through electron-builder. These commands do not establish signing, notarization, publication, or compatibility with every Mac. Final binary distribution details remain to be confirmed.

The cart has its own lockfile and test dependency:

```sh
cd examples/cart
npm ci
npm run browsers
npm test
npm run test:contract
```

Keep the baseline smoke test distinct from the recorded coupon journey. The separate contract suite checks the sample's behavior; it is not evidence that the app recorded or generated a correct test. Follow the [generated-test mutation procedure](docs/GETTING-STARTED.md#verify-the-deliberate-discount-bug) for generation changes.

## Pull requests

1. Create a focused branch and describe the user-visible problem.
2. Update the shared types, relevant implementation, docs, and meaningful tests together when changing a contract.
3. Run checks relevant to the change. Report exact commands, environment, failures, and checks not run. Never label a timeout, missing dependency, or skipped check as a pass.
4. For recorder or generator changes, include a sanitized scenario, generated diff, actual test names, and verification output. For discount detection, show a healthy run and the same generated test failing on $95.00 instead of $90.00.
5. Submit the PR once the public repository is available. Keep credentials, private project source, browser state, screenshots with personal information, and local generated workspaces out of the contribution.

CI runs the root checks and cart tests without Codex credentials. It does not exercise the full desktop UI, consume a maintainer's Codex account, or publish a release. Report security issues through [SECURITY.md](SECURITY.md), not a public reproduction containing secrets.
