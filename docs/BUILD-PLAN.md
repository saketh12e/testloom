# JourneyProof 0.1 build plan

Mac desktop app, local folder input, Codex-first test generation. Browser research is part of development only; the product does not contain a web-search feature.

1. Research current Codex, Electron and Playwright contracts; define one shared scenario and IPC API.
2. In parallel, implement the browser recorder, desktop interface, and a runnable cart example with contributor documentation.
3. Implement repository inspection, isolated snapshots, read-only Codex structured generation, path-gated generated files, bounded verification and evidence export.
4. Integrate and exercise the actual desktop flow. Verify the cart test passes and detects a broken discount calculation. Audit failure and security boundaries.
5. Build a Mac application and source package, publish a public MIT repository, and document exact tested capabilities and remaining limits.

Release boundary: dependable first release, not universal framework coverage or zero-defect claims. Repository adaptation is Codex-driven. Built-in deterministic generation targets Playwright TypeScript and Playwright Java. Claude is an extension opportunity, not an implemented provider.
