# Roadmap

Testloom v0.3 adds native case conversations, screenshot input, maximum reasoning and bounded source tools on top of editable case libraries and selected batches. A synthetic 100,000-source-file scan/copy is measured; real production repository pilots remain necessary. These are preview capabilities. Broader rollout needs evidence from the environments people will actually use.

| Priority | Next work | Evidence needed before calling it ready |
| --- | --- | --- |
| Release distribution | Apple Developer signing/notarization and repeatable release packaging | Install, launch, record, generate, verify and export on a clean Apple Silicon Mac; publish versions, checksums and failures |
| Provider compatibility | Maintain an explicit CLI/model compatibility matrix | Actual authenticated Codex and Claude runs with structured outputs; healthy control and unchanged-test defect detection; distinguish outages and budget failures |
| Batch reliability | Exercise libraries and selected batches in real projects | Restart/switch/import/edit/disable/cancel reproductions; no case-output collisions; report discovery and unchanged-source evidence for the exact build |
| Java and other runners | Add Maven/Surefire, Gradle and further report adapters | Detect missing, skipped and unexpected generated-test outcomes, with healthy controls and failing witnesses |
| Recorder isolation | Move instrumentation out of the page world and publish an interaction capability matrix | Reproductions for frames, shadow DOM, popups, uploads, dialogs and shutdown; unsupported cases remain explicit |
| Context quality | Add dependency-aware retrieval and refresh controls | Show which helpers/imports are included, what is stale or omitted, and that exclusions survive refresh; bound prompts visibly |
| History and storage | Add case revisions, explicit retention and reviewed cleanup | Restore a requirement revision without rewriting raw evidence; remove only selected owned artifacts; document recovery and disk use |
| Safe repair proposals | Generate a new reviewable proposal from a failure | Keep requirement IDs and expectations unchanged; the repaired test must pass a healthy control and detect the same known defect |
| Broader coverage | Reviewed visual requirements, more browser engines and platform testing | Privacy controls plus actual assertion evidence and a published machine/browser matrix |

## Roll out in stages

1. **Personal evaluation:** run the synthetic demo and inspect the case JSON, generated files and actual results. Keep a backup when upgrading preview data.
2. **One trusted module:** review the commands and context, supply disposable test data, and prove a healthy pass plus a known-defect failure with the same generated test. Export reviewed code through the team's normal review process.
3. **Team pilot:** record toolchain versions, observed false passes, repeatability, provider failures and maintenance effort. Agree on data-sharing and storage practices before confidential work.
4. **Broader adoption:** complete relevant release, runner and provider checks above; define supported versions and a security response policy. Publish the actual limits and remaining failures.

Measure time to a useful reviewed test, generated-test discovery, defect detection, false passes and maintenance effort. A 500-case storage limit does not establish 500-case execution quality, and it says nothing about thousands of verified tests. No production-readiness date is promised.
