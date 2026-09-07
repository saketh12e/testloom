# Testloom v0.2 build and release plan

The release scope is a Mac workspace for editable browser-test suites: local project input, Codex as the primary adapter, Claude Code as an alternative and portable generation for supported Playwright projects. Browser research informs development; Testloom is not a web-search product.

1. Keep `src/shared/types.ts`, the suite runtime validator and the public v2 schema aligned. Preserve v1 scenario meaning, raw observations and user-authored requirements.
2. Integrate 500-case project libraries, 1–20-case generation batches, case editing, suite exchange, bounded context selection/preview and provider controls. Use separate case output folders and preserve source-copy boundaries.
3. Exercise the three hand-authored cart examples and a newly recorded journey. Check persistence, folder switching, import collisions, disabled cases, cancellation and history. A negative case passes through an asserted rejection.
4. Validate generated tests against both the healthy cart and its disclosed discount mutation without changing the test. Exercise Java compilation and live providers separately; retain exact versions, commands and outcomes.
5. Check the native desktop and packaged Apple Silicon app, then refresh screenshots from actual UI runs. Update [VALIDATION.md](VALIDATION.md) with completed evidence before publishing release claims.
6. Publish the renamed Testloom repository and release assets with checksums. Preserve the old repository redirects and recognized JourneyProof data. Keep the unsigned/unnotarized preview status visible.

Use [Architecture](ARCHITECTURE.md) for implemented boundaries, [Release notes](RELEASE-0.2.md) for user-facing changes and [Roadmap](ROADMAP.md) for work required beyond this preview. A plan item, passing unit test or upstream CLI capability is not a completed release check.
