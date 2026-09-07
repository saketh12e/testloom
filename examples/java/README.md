# Playwright Java example

A Maven/JUnit 5 project for the actual JourneyProof portable Java generator. Requires **JDK 17+**, Maven, Node.js 20.19+, and Chromium. The independent `BrowserSmokeTest` edits a labeled gift note in a local page; it does not implement the coupon journey. Each test owns a Playwright instance, browser, and fresh context.

The POM pins **Playwright Java 1.62.0**, JUnit **5.13.4**, compiler plugin **3.14.1**, Surefire **3.5.4**, and exec plugin **3.5.1**. Java and npm Playwright have separate release versions; this example uses the Java dependency and its matching browser revision.

## Setup and baseline

Set `JAVA_HOME` to your JDK and add its `bin` and Maven's `bin` to `PATH` for your invocation. Check `java -version` and `mvn -version`. No global installation changes are needed. From this folder:

```sh
mvn exec:java -Dexec.mainClass=com.microsoft.playwright.CLI -Dexec.classpathScope=test '-Dexec.args=install chromium'
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 mvn test
```

Installation obtains the Chromium revision required by the Java dependency; a cached npm browser may not match. Network access is needed for initial Maven/browser setup. If setting `PLAYWRIGHT_BROWSERS_PATH`, keep it consistent for installation and execution. See [official installation](https://playwright.dev/java/docs/intro) and [JUnit integration](https://playwright.dev/java/docs/test-runners).

## Actual recording and generated-test verification

From the repository root, after root `npm ci` and `npm run browsers`, run:

```sh
JAVA_HOME='/path/to/jdk-17/Contents/Home' PATH='/path/to/jdk-17/Contents/Home/bin:/path/to/apache-maven/bin:'"$PATH" ./node_modules/.bin/tsx tests/java.integration.ts
```

Replace paths with your installations. `MAVEN_EXECUTABLE` can specify an absolute Maven executable. No root package-script change is required.

The script inspects and snapshots this project and the cart into ignored `work/java-integration-*`, installs matching Java Chromium through Maven, and runs the baseline. It starts only its copied cart server on **127.0.0.1:4329**, refusing an occupied port without touching the existing process. The actual `BrowserRecorder` captures navigation, adding the $40 notebook and $60 bag, filling SAVE10, and applying the coupon. Recording stops and flushes before adding the user-authored exact total assertion `$90.00`.

It invokes the actual `portableGenerate` and append-only `writeGeneratedFiles`, then Maven compiles and executes that specific generated JUnit class in the copy. It restarts its owned server with `JOURNEYPROOF_BROKEN_DISCOUNT=1` and executes the unchanged class. Mutation detection requires a completed assertion failure with $90.00/$95.00 evidence, one test, no skips, and no test errors. Missing dependencies, missing tests, and process timeouts cannot satisfy it.

Owned processes are stopped and original Java/cart source hashes compared. The latest result is `work/java-verification.json`; each retained run directory contains its result, command logs, scenario, generated project/patch, and available Surefire reports. The integration reads the dependency version from the shipped POM and passes no Maven version override. The summary records `testedVersion`, `versionSource`, `versionOverride: false`, and `pinnedVersionVerified`. Exit zero means the healthy run, expected mutation failure, and preservation checks all passed; the broken Maven invocation itself should exit one.

Verified on **2026-09-07** with the shipped **Playwright Java 1.62.0** POM, JDK **17.0.20.1**, and Maven **3.9.16**, without a version override: the baseline passed, the actual generated coupon test passed against the healthy cart, and the unchanged generated test failed against the mutation with **$90.00 expected / $95.00 received**. The integration recorded five events, preserved both original source folders during execution, and reported `pinnedVersionVerified: true` in `work/java-verification.json`.

This checks the real portable generator and recorder, not the Electron interface, Codex mode, or arbitrary Java projects. The source example contains no pre-generated coupon test.

## IntelliJ IDEA

Open this folder's `pom.xml` as a Maven project. Select JDK 17+ as the project SDK and Maven runner JRE, then reload Maven. Run the Chromium installation goal first, then `BrowserSmokeTest` or Maven `test`. The POM supplies the dependency versions without extra Maven properties.

To inspect an actual generated class, open the `generated-project/pom.xml` identified by the integration result. Generated code appears under `src/test/java/journeyproof`. The integration stops its server on completion; rerunning that coupon class manually needs a server in another terminal:

```sh
# From the JourneyProof repository root.
PORT=4329 node examples/cart/server.mjs
```

Run Maven with the generated class name, for example `mvn test -Dtest=journeyproof.Journey12345678Test`, replacing the class name with the one in your result. For a deliberate mutation, start the server with `PORT=4329 JOURNEYPROOF_BROKEN_DISCOUNT=1` and keep the expected assertion at $90.00. No step uses port 4318.

Repository scripts run with local user rights. A source copy is not an OS sandbox; use trusted projects and disposable data.
