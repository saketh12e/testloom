# Scenario format v1

JourneyProof's interchange format is a JSON document governed by [scenario-v1.schema.json](../schemas/scenario-v1.schema.json). It is independent of Codex and of any generated programming language. An exporter should preserve unknown future versions rather than silently reinterpret them; this release accepts version 1 only.

## Three separate things

1. **Observations**: ordered events, semantic locator candidates, page identity, selected visual evidence, and request method/path/status. These describe what the tester did and what was observable.
2. **Requirements**: separately authored assertions, each with an ID, description, expected value, and `source: "user"`. An observed UI value is never promoted automatically into a requirement.
3. **Execution evidence**: a separate verification document with the actual command, exit statuses, output, repeat runs, and generated-file SHA-256 hashes. The recommended Playwright command additionally confirms generated test discovery from its JSON report.

## Locator ordering

The recorder emits candidates in preference order: test ID, named accessible role, associated label, then structural CSS. The portable compiler selects the first candidate and uses Playwright's strict matching and waiting. Ambiguous or unstable locators can still fail and require review. The format stores the alternatives for a future adapter or Codex to consider. A CSS fallback is not an assurance of future stability.

## Event semantics

`sequence` is increasing observed delivery order, starting at 1. Timestamps are capture timestamps, not a distributed causal clock. Consecutive edits in one field are coalesced until another action or stop flushes the value. A navigation following a click is an observation of that click's result, so the portable compiler emits a URL assertion rather than a second `goto` that could conceal broken navigation.

URL observations remove query, fragment and embedded credentials. Navigation assertions compare the origin/path while permitting query/fragment suffixes. An explicit user-authored URL assertion remains exact. This format cannot reconstruct discarded query state. Screenshots are optional post-action observations, may be captured after additional rendering, are masked on a best-effort basis, and remain local unless the tester exports them. Codex 0.1 consumes the structured ledger and selected source excerpts, not those screenshots.

`redacted: true` means the value is unavailable for direct replay. Portable generation refuses it; Codex must use an appropriate existing fixture or request missing information. It must never synthesize a credential. `warnings` preserve unsupported operations and incomplete capture. Frames, file uploads and other unsupported events cannot silently become a passing portable test.

## Bounds and extension rules

The recorder caps a journey at 500 events and 2,000 network entries. Generation accepts at most 30 assertions and 12 files, each no larger than 150,000 characters. Repository scanning is separately bounded. Limits produce visible warnings or errors.

New action semantics require a new compatible adapter and regression fixtures before being advertised. Breaking changes to field meaning require a schema version bump. A future branching scenario format, alternative agent provider, visual assertion adapter, or verified repair loop should preserve requirement IDs and never rewrite expectations to match a failing product.
