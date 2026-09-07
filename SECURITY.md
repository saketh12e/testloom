# Security

## Reporting a vulnerability

For the planned repository [saketh12e/journeyproof](https://github.com/saketh12e/journeyproof), use **Security → Report a vulnerability** if GitHub private vulnerability reporting is enabled. Availability has not been confirmed. If that option is absent, open only a minimal, non-sensitive issue requesting a private reporting channel, or use a private contact explicitly published by the maintainer. Do not post exploit details, credentials, private source, traces, or personal data publicly while arranging contact.

A private report should include the affected version or commit, OS and Node version, the trust boundary crossed, a minimal sanitized reproduction, expected behavior, and impact. There is no published response-time commitment or support matrix yet; maintainers should define these before a stable release.

## Execution and data boundaries

- Connect only repositories whose scripts you trust. Dependency installation, build tools, test commands, browser actions, and their subprocesses execute with local user rights and may access the network, credentials, or files outside the copied project. A working copy is not an OS sandbox.
- App generation is designed to add tests to a separate copy and leave the connected original untouched. That does not prevent a repository script from modifying other files or sending requests to external services. Review commands and use disposable accounts and data when appropriate.
- The Electron interface and the recorded website have separate roles. Context isolation, a narrow preload bridge, and IPC validation protect the interface boundary; they do not sandbox arbitrary test commands.
- Codex mode uses the installed CLI and its login. JourneyProof does not collect an API key or provide its own model allowance. Relevant project and scenario context may be sent to the model provider through that CLI. CLI configuration, account policies, and enabled integrations matter.
- Redaction and excluded filenames reduce exposure but cannot identify every secret. Input text, URLs, screenshots, network metadata, logs, tests, and exported bundles can contain sensitive information. Review them before sharing. Prefer screenshots off for sensitive flows.
- The bundled cart binds to loopback and uses disposable in-memory sessions. It is a local testing fixture, not a production commerce service or authentication system. It has no checkout or real payment processing.

Potential vulnerabilities include generated paths escaping the workspace, renderer access to unrestricted native APIs, unintended source writes, and sensitive data crossing a boundary without the user's awareness. Demonstrate these with synthetic data whenever possible.
