# Suite v2 and scenario v1

Testloom v0.2 exchanges a **version 2 suite containing version 1 scenarios**. The [v2 JSON Schema](../schemas/scenario-v2.schema.json) describes the portable shape. `src/core/suite.ts` is the runtime import/export validator; `src/core/generator.ts` separately checks whether a draft can generate a test. The [v1 schema](../schemas/scenario-v1.schema.json) remains a historical standalone-scenario reference.

```json
{
  "schemaVersion": 2,
  "name": "Testloom suite",
  "cases": []
}
```

An empty suite is structurally valid, but generation needs at least one selected enabled case with events and explicit assertions. Use the complete [three-case cart fixture](../examples/cart-suite-v2.json) for an importable example. It is hand-authored for the standalone cart at port 4318; the desktop demo creates its own cases using its chosen port. Review URLs before importing this fixture into another project.

## Case fields

| Field | Meaning and bounds |
| --- | --- |
| `id` | Case identity, unique within the suite |
| `name` | Nonblank display name, at most 120 characters |
| `kind` | `positive`, `negative` or `boundary`; classification only |
| `priority` | `critical`, `high`, `normal` or `low`; organization metadata |
| `tags` | Up to 12 nonblank strings, at most 40 characters each |
| `enabled` | Required boolean; disabled cases remain stored but cannot be generated |
| `recordingId` | Reference to the original recording, not a filesystem path |
| `scenario` | Editable v1 scenario with its own ID, name, events and requirements |
| `updatedAt` | ISO timestamp with a timezone |

IDs are at most 128 characters, start with a letter or digit, and otherwise use letters, digits, underscores or hyphens. Case IDs and nested scenario IDs are separately unique across the suite. Event and assertion IDs are unique within their scenario. Duplicating a case gives the case and scenario new IDs while retaining the recording reference and requirement IDs. Multiple cases may share one recording reference.

Selecting a kind never generates a new requirement or changes the runner's expected status. A negative coupon case passes when it observes the specified rejection and unchanged total. A process error is not an expected rejection unless the actual test explicitly asserts the intended application behavior.

## Observations, requirements and evidence

The recorder writes the original observation ledger separately. Case edits change a working scenario without overwriting that recording. Suite files carry editable scenarios and recording references, not raw recording files. The three sample cases are authored examples and must not be presented as captured user sessions.

A v1 scenario requires `schemaVersion`, `id`, `name`, `startUrl`, `createdAt`, `events`, `assertions`, `warnings` and `network`. Assertions have a stable ID, description, kind, expected value and `source: "user"`. Text and visibility checks require a locator. URL assertions contain an explicit URL. Custom assertions express intent for an agent/manual implementation; Portable refuses them.

Execution evidence is separate from the suite: commands, statuses, durations, output, generated-file hashes and available discovery records. An imported suite contains no proof that it has run. An evidence bundle distinguishes the current library (`suite.json`) from the selected cases used for generation (`generated-suite.json`).

## Events and locators

Supported vocabulary: `navigate`, `click`, `fill`, `check`, `uncheck`, `select`, `press`, `popup`, `note`. Not every named event is replayable by Portable. Frames, other pages, unsupported notes and redacted inputs need explicit review or adaptation.

Each event has an ID, sequence, timestamp, action, URL, page ID, label and up to eight locator candidates. `fill`, `select` and `press` need a value; an empty fill value is valid. Keyboard values use the validator's bounded key/modifier vocabulary. Actions other than navigation, popup and note require at least one locator. Optional fields include redaction, screenshot, frame selectors and warnings.

Locator strategies are `testId`, `role`, `label`, `placeholder`, `text` and `css`. The recorder prefers test IDs, named accessible roles and labels before structural CSS. Portable uses the first candidate with strict matching and condition-based waits. Stored alternatives do not guarantee stable selectors; role values must be lowercase letters.

Sequence numbers range from 1 to 500 and increase strictly in observed delivery order; imported sequences need not be contiguous or start at 1. Timestamps are capture times, not a distributed causal clock. Consecutive edits in one field are coalesced until another action or stop flushes the value. A navigation following a click is an observation of its result: Portable asserts the URL rather than emitting a second navigation that could hide a broken click.

Recorder URL observations drop query, fragment and credentials. Portable navigation checks permit query/fragment suffixes after the observed origin/path; user-authored URL assertions remain exact. Imported URLs must be HTTP(S), without credentials or recognizable secret-bearing components. Harmless query data may remain in an imported URL; review it. Redaction cannot reconstruct discarded state.

## Import/export rules and limits

The suite importer accepts only version 2 and rejects unknown fields. It validates the complete input before adding cases. Importing into a project clones colliding case IDs and adds cases; it does not silently replace existing requirements. Unknown future versions must be preserved outside the app for a compatible reader, not reinterpreted.

The file importer caps input at 5,000,000 bytes; the structural validator also caps serialized input at 5 MiB. Keep exports below the smaller file bound for portable round trips. A suite and a project library allow up to 500 cases. Each scenario allows 500 events, 30 assertions and 2,000 request entries. Warnings allow 64 entries of at most 2,000 characters. See the schema for field-specific lengths.

Suite export reconstructs the public shape, scrubs recognizable secrets and removes screenshot references. Import validates then discards supplied screenshot paths; it never uses them to read local files. `redacted: true` makes replay values unavailable; import normalizes non-keypress redacted values to `[REDACTED]`. Existing fixtures or synthetic data are needed for replay. Screenshots may separately appear in a reviewed evidence bundle.

JSON Schema validates structure, not all runtime semantics. The runtime additionally checks serialized UTF-8 byte size, uniqueness by ID, strict sequence order, calendar/URL validity, encoded secret patterns and JavaScript string-length bounds. Generation adds readiness checks: at least one event and assertion, meaningful expected values and supported actions. Valid JSON is neither a safe-command guarantee nor an executable-test guarantee.

Breaking field meanings need a new format version and migration guidance. New action semantics need an adapter and healthy/failing fixtures. Preserve requirement IDs and expected outcomes when repairing automation.
