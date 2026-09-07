# Opening the Mac preview

## Replace v0.2.0

The v0.2.0 download was packaged without a complete app-bundle signature. Its main executable retained a linker signature, and `codesign --verify --deep --strict` failed with `code has no resources but signature indicates they must be present`. A friend reported macOS's “damaged and can't be opened” alert. Running the app on the build Mac did not catch this distribution problem.

Use the **v0.2.1 Apple Silicon download** from [the public release](https://github.com/saketh12e/testloom/releases/tag/v0.2.1). Quit Testloom, unzip the new download, and replace **Testloom.app** in Applications. This replaces the app, not the case library in Application Support. Intel Macs need to build from source on their own Mac.

The new package has a complete **ad-hoc code signature** and is verified again after ZIP extraction. This checks integrity; it does **not** identify an Apple-approved developer or provide notarization. It remains a developer preview and can still be blocked by Gatekeeper.

## Open a trusted preview

1. Download the ZIP and checksum file from the release above. In Terminal, check the download (adjust the path if your browser saves elsewhere):

   ```sh
   cd ~/Downloads
   shasum -a 256 Testloom-0.2.1-mac-arm64.zip
   ```

   Compare the result with the app's line in **TESTLOOM-0.2.1-SHA256SUMS.txt** on that release.

2. After moving the app to Applications, verify its signature:

   ```sh
   codesign --verify --deep --strict --verbose=2 "/Applications/Testloom.app"
   ```

   It should report `valid on disk` and satisfy its designated requirement. If verification fails, stop and download a fresh copy; do not repair a downloaded signature yourself.

3. Try opening it. If macOS blocks this trusted preview, use **System Settings → Privacy & Security → Open Anyway**, then confirm Open. [Apple explains this per-app exception](https://support.apple.com/en-us/102445).

4. If no Open Anyway option appears, and both checks above passed, you can explicitly remove the download quarantine **for this Testloom app only**:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Testloom.app"
   open "/Applications/Testloom.app"
   ```

   This bypasses the downloaded-app check for this preview; it is not notarization or a malware scan. Do this only for the verified Testloom download you chose to trust. No `sudo` or global Gatekeeper changes are needed. A managed work Mac may require IT approval instead.

For a preview that you build yourself, use the source instructions in [Getting started](GETTING-STARTED.md).

## Proper distribution

Warning-free distribution requires an Apple Developer ID Application certificate, hardened-runtime signing, notarization and stapling. No valid signing identity was available on the release Mac. The release must not be described as notarized or as verified on another user's Mac until those checks actually pass. See [electron-builder's signing documentation for v26](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

The packaging hooks now reject an invalid signature before archiving and again after extracting the ZIP. CI builds a Mac ZIP. A regression fixture also proves that an incomplete signature or a resource changed after signing fails the release check.
