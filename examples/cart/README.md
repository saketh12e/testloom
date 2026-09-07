# Field Supply cart

A disposable local shopping cart for recording a complete JourneyProof scenario. Requires Node.js 20.19+; no database, framework, external assets, or runtime packages. `@playwright/test` is pinned to **1.63.0**.

```sh
npm ci
npm run browsers
npm start
```

Open **http://127.0.0.1:4318**. `PORT=4320 npm start` uses another loopback port. Stop with Ctrl+C. The desktop app copies this folder and owns its demo server; no separate manual server is needed for that path.

## The journey to record

Start recording before these actions: add **Field notebook** ($40.00), add **Canvas bag** ($60.00), enter **SAVE10**, and click **Apply coupon**. Subtotal is $100.00; the 10% discount is $10.00; total is exactly **$90.00**. Stop recording, then add a text assertion targeting `testId: total` with expected `$90.00`. See the [desktop walkthrough](../../docs/GETTING-STARTED.md).

| Control or value | Stable `data-testid` |
| --- | --- |
| Add Field notebook | `add-notebook` |
| Add Canvas bag | `add-bag` |
| Coupon code, with an explicit label | `coupon` |
| Apply coupon | `apply-coupon` |
| Subtotal / discount / total | `subtotal` / `discount` / `total` |
| Coupon error / status | `coupon-error` / `coupon-status` |
| Quantity inputs | `quantity-notebook` / `quantity-bag` |
| Remove controls | `remove-notebook` / `remove-bag` |
| Reset this session | `reset-cart` |

Quantity changes commit on blur or Tab. Zero removes a product; quantities must be integers from 0 to 99. **INVALID** shows an invalid-coupon error; **EXPIRED** shows an expiration error. Both clear any previous discount. Prices and amounts use integer cents; coupon discount is rounded once at the order level. Coupon input is trimmed and case-insensitive.

Each browser context has its own cookie-backed server cart. Tabs in the same context share a session; reload retains it. Reset affects only that session. Sessions live in memory, expire after two hours of inactivity, and disappear when the server restarts. There is no real checkout or payment.

## Tests

```sh
npm test
npm run test:contract
```

`npm test` uses Playwright's `webServer` and runs `tests/smoke.spec.ts`: add one notebook, change its quantity, then remove it. It also discovers any app-generated `tests/journeyproof/<slug>.spec.ts`. The baseline is deliberately a different journey and does not validate SAVE10.

`npm run test:contract` selects the separate `checks` folder for fixture maintenance: discount arithmetic, invalid/expired codes, session separation, quantity zero, and reset. These handwritten checks are not evidence that JourneyProof generated a correct test.

For mutation verification, stop any existing server and run the **same generated coupon test** against fresh healthy and broken servers:

```sh
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=0 npm test -- tests/journeyproof/save-ten-on-essentials-12345678.spec.ts
JOURNEYPROOF_FRESH_SERVER=1 JOURNEYPROOF_BROKEN_DISCOUNT=1 npm test -- tests/journeyproof/save-ten-on-essentials-12345678.spec.ts
```

Replace `12345678` with the short ID in the actual generated filename. The second command is intended to fail with expected $90.00, received $95.00. Mutation mode deliberately applies a 5% discount. Port conflicts or missing dependencies are not successful detection. The sample config refuses server reuse for mutation/fresh-server checks; ordinary local runs can reuse an existing server. Desktop verification stops its demo server first, letting Playwright start the same URL. `PORT` also configures the test server and base URL.

This fixture is intended for local testing. Binding to loopback and copying a project do not sandbox repository commands or make the server production-ready.
