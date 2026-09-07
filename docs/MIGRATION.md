# Moving from JourneyProof to Testloom

Testloom is the v0.2 product name. The repository was renamed from `saketh12e/journeyproof` to `saketh12e/testloom`; GitHub redirects the old URL. Existing clones and local folder names need not change. Update your remote if desired:

```sh
git remote set-url origin https://github.com/saketh12e/testloom.git
```

The rename does not change the MIT license.

## Existing Mac data

Quit the old app and back up its data before upgrading. Testloom checks the legacy `JourneyProof` and `journeyproof` folders under Electron's Application Support directory for `workspace/session.json` and reuses the first matching location. It does not intentionally create a second library when a recognized legacy session exists.

Data-folder aliases, including capitalization differences on macOS, are matched by directory identity. A saved v1 session with recorded events and no cases is wrapped as an editable positive case. Its existing assertions remain user-authored requirements. This is session migration, not a promise that every old exported file can be imported as a v2 suite.

`TESTLOOM_DATA_DIR` can explicitly choose an app data directory; the older `JOURNEYPROOF_DATA_DIR` is still accepted. The new variable takes precedence if both are set. These overrides name the user-data directory containing `workspace`, not the workspace subfolder itself. Changing the location does not copy data automatically. If an expected library is missing, check the selected data location and canonical project folder before recording more work.

Each connected project has its own persisted library keyed by canonical path. Reopening the same folder restores its cases and history. After moving a project, export the suite from the old location and import it at the new one. The demo creates a fresh sample copy each time; keep work you want by exporting it or reopening that sample folder.

## Names intentionally retained

| Name | Reason |
| --- | --- |
| `.journeyproof/` inside run workspaces | Existing provenance, generation and verification artifacts stay readable |
| Electron app ID `dev.journeyproof.app` | Application identity compatibility |
| Internal `journeyproof://` scheme, `journey:` IPC channels and `JourneyAPI`/service identifiers | Internal implementation compatibility; the interface is branded Testloom |
| `JOURNEYPROOF_*` fixture variables | Existing sample and validation commands remain usable |
| Old `tests/journeyproof` output and Java package `journeyproof` | Historical generated files remain ordinary code; they are not rewritten automatically |

New generated files use `tests/testloom/case-<id>/` or `src/test/java/testloom/case-<id>/`; portable Java uses `package testloom`. Review project discovery rules before adopting new output if your old configuration only includes `journeyproof` paths.

## Suite and evidence compatibility

The v2 suite envelope has `schemaVersion: 2`, a name and a case array. Each case still embeds a `schemaVersion: 1` scenario. [The format guide](SCENARIO-FORMAT.md) explains the distinction. The v1 schema remains available for historical standalone scenarios; the suite importer requires the v2 envelope and does not silently reinterpret unknown versions.

Suite exports omit local screenshot paths, project configuration and provider settings. They preserve editable case data and recording references, not the raw recording files themselves. Import validates the entire suite before adding cases, and remaps colliding case IDs by cloning. Review the destination project, URLs and requirements after import.

Historical v0.1 verification remains evidence for its recorded test bytes and environment. Do not relabel it as v0.2 provider, batch or packaged-app validation. Run new checks for the version you plan to use. Downgrading a v0.2 session into v0.1 is not a supported migration; retain the backup.
