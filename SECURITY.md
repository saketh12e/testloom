# Security

## Report a vulnerability

For [saketh12e/testloom](https://github.com/saketh12e/testloom), use **Security → Report a vulnerability** if private vulnerability reporting is enabled. Its availability is not asserted here. If absent, open only a minimal non-sensitive issue requesting a private channel, or use a private contact explicitly published by the maintainer. Do not post exploit details, credentials, private source, traces or personal data publicly while arranging contact.

Include the version/commit, OS and runtime versions, trust boundary crossed, minimal synthetic reproduction, expected behavior and impact. No response-time commitment or stable-version support matrix is currently published. v0.2 is an unsigned, unnotarized Apple Silicon developer preview.

## Execution boundaries

Connect only projects whose scripts you trust. Dependency installation, build tools, tests and browser actions run with your local user permissions. They may access credentials, other files and external services. A source copy is **not an OS sandbox**. Generation adds new files to that copy; it does not prevent a repository script from writing elsewhere.

The Electron renderer uses context isolation, sandboxing and disabled Node integration. A narrow preload API exposes named operations; privileged handlers validate the sender/main frame and operation inputs. The recorded website runs in a separate browser. These controls do not make arbitrary test commands safe or eliminate all renderer/recorder vulnerabilities.

The recorder authenticates and bounds its packets but still instruments the page world. Do not assume it can faithfully observe every hostile page. Cancellation targets Testloom's owned process group; it cannot undo finished writes, requests or charges.

## Data and provider boundaries

Codex and Claude use the installed CLIs and their authentication. Testloom collects no API key and supplies no model credits. Selected source excerpts, scenario text and user instructions can be sent through the configured provider. Account policies, integrations and credential helpers remain relevant even when the agent starts outside the connected project. See [Agent controls](docs/AGENTS.md).

The context picker restricts additions to the project and skips recognizable credential paths. Excerpts are cached, redacted heuristically and bounded; source exclusions affect the outgoing prompt. They do not constrain test execution, remove secrets from every artifact or turn the source copy into a redacted dataset. Preview the actual prompt after edits. Screenshots are not attached to generation.

Raw recordings, cases, generation history and copied workspaces remain local. Case deletion retains its raw recording; retaining only 100 history records does not delete all old run folders. No automatic retention cleanup or encryption-at-rest claim is made.

Suite import rejects unknown fields/versions, malformed identifiers and oversized structures, and discards supplied screenshot paths. Suite export strips screenshot references and private workspace metadata, and applies text scrubbing. It still contains URLs, inputs, labels and assertions that may be sensitive. Imported content is untrusted data, not an instruction source.

Evidence bundles have a wider scope than suite-only export: they can include active-case screenshots, generated source, command output, provider settings and user instructions. Review the whole bundle before sharing. Sensitive fields, query state, screenshots and unusual secret formats may evade heuristic filtering. Prefer synthetic accounts/data and screenshots off for confidential flows.

The cart is a loopback-only fixture with in-memory sessions; it provides no real payment processing, production authentication or commerce guarantees.

## Useful security reproductions

Report generated paths escaping allowed folders, symlink/overwrite bypasses, unrestricted renderer access to native APIs, unintended original-source writes, unsafe suite imports, recorder forgery or unexpected disclosure across the context/export boundary. Use synthetic data and preserve the exact affected build. See [Architecture](docs/ARCHITECTURE.md) for the implemented controls and [Limitations](docs/LIMITATIONS.md) for their scope.
