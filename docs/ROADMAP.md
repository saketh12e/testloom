# Roadmap

The 0.1 release completes a local Mac recording → explicit requirement → generated test → execution evidence → export workflow. Its next increments should be driven by reproductions from real test repositories.

## Next engineering priorities

1. Move recorder instrumentation to an isolated browser world, with documented semantics for frames, shadow DOM, dialogs, downloads and uploads. Add a visible replay capability matrix per event.
2. Add Maven/Surefire, Gradle and additional runner report adapters that prove generated-test discovery as explicitly as the Playwright adapter.
3. Retrieve repository context from imports and fixture dependencies, with a preview and selectable exclusions before model submission.
4. Introduce saved scenario collections, editable action descriptions and fixture bindings. Preserve immutable raw observations and version every requirement edit.
5. Add bounded repair proposals that consume failures and produce reviewable new tests while preserving requirements. Validate against known defect fixtures; never optimize simply for a green result.
6. Support reviewed screenshot attachments, visual requirements and richer state evidence with local privacy controls.
7. Add a documented provider interface for Claude and other coding agents without changing the scenario format or requiring AI for routine test execution.
8. Establish Apple Developer signing/notarization, clean-machine installers and an Intel/Apple Silicon test matrix before calling distribution production-ready.

## Contribution bar

For each new capability, supply the user-facing behavior, an unsupported-case boundary, a focused reproduction, a healthy control, and an actual failure witness where appropriate. Keep requirement changes separate from automation repairs. Measure first successful test time, generated-test discovery, false passes, repeatability and maintenance effort rather than lines of generated code or star counts.
