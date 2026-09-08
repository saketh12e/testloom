import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import playwrightPackage from 'playwright/package.json';

export function missingBrowser(error: unknown): boolean {
  return /TESTLOOM_BROWSER_MISSING|executable.*(doesn.t exist|not found)|distribution.*not found|browser.*not found|please run.*playwright install/i.test(
    String(error).split(/\r?\n/, 1)[0],
  );
}

/** Fixed messages only: Playwright's raw errors can contain URL tokens or page text. */
export function recordingStartupMessage(
  error: unknown,
  stage: 'browser' | 'setup' | 'navigation',
): string {
  const detail = String(error);
  if (stage === 'browser' && missingBrowser(error))
    return `No recording browser was found. Install Google Chrome or Microsoft Edge, or run npx playwright@${playwrightPackage.version} install chromium once, then retry. This does not mean the website URL is invalid.`;
  if (/net::ERR_(?:CERT_[A-Z_]+|SSL_[A-Z_]+)/.test(detail))
    return 'The website’s HTTPS certificate could not be verified. Check the certificate and any required company VPN or trusted certificate setup. Testloom keeps HTTPS verification enabled.';
  if (/net::ERR_(?:NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)/.test(detail))
    return 'The website’s hostname could not be resolved. Check the address and connect to the required company VPN or DNS network, then retry.';
  if (/net::ERR_(?:PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|NO_SUPPORTED_PROXIES)/.test(detail))
    return 'The recording browser could not connect through the network proxy. Check your company proxy or VPN configuration, then retry.';
  if (
    /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_FAILED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED)/.test(
      detail,
    )
  )
    return 'The recording browser could not reach the website. Check that it opens on this Mac and that the required VPN, network and service are available.';
  if (/net::ERR_TOO_MANY_REDIRECTS/.test(detail))
    return 'The website redirected too many times. Check its sign-in or SSO redirect configuration, or start from its login page.';
  if (/net::ERR_(?:BLOCKED_BY_[A-Z_]+|ACCESS_DENIED)/.test(detail))
    return 'Access was blocked by the browser, network or device policy. Ask your administrator to allow the recording browser and this website.';
  if (/TimeoutError|timeout.*exceeded|net::ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)/i.test(detail))
    return stage === 'navigation'
      ? 'The website did not respond in time. Check its availability and any required VPN, then retry. The recording browser is installed.'
      : 'The recording browser did not become ready in time. Close its leftover windows, check device policy, then retry.';
  if (/Target.*closed|browser.*closed|page.*closed/i.test(detail))
    return 'The recording browser closed before startup finished. Keep its window open while recording; check device policy if it closes by itself.';
  if (/EACCES|EPERM|permission denied/i.test(detail))
    return 'Testloom could not access its recording browser or local recording folder. Check Mac permissions and device policy, then retry.';
  return stage === 'browser'
    ? 'The recording browser could not launch. Check that Chrome or Edge can open on this Mac and that device policy permits automation.'
    : stage === 'setup'
      ? 'The browser opened, but recording setup failed. Check local disk space and permissions, then retry.'
      : 'The browser opened, but navigation failed. Check this address in a browser on the same Mac, including any required sign-in, VPN or company access policy.';
}

/** A missing bundled browser must not prevent use of an already installed browser. */
export async function launchRecordingBrowser(
  options: LaunchOptions,
  warn: (message: string) => void,
  checkCancelled: () => void,
): Promise<Browser> {
  const candidates: { label: string; options: LaunchOptions }[] = [
    { label: 'Playwright Chromium', options: {} },
    { label: 'Google Chrome', options: { channel: 'chrome' } },
  ];
  const userBrowser = async (name: string, executable: string) => {
    if (process.platform !== 'darwin') return;
    const executablePath = path.join(
      homedir(),
      'Applications',
      `${name}.app`,
      'Contents/MacOS',
      executable,
    );
    try {
      await access(executablePath, constants.X_OK);
      candidates.push({ label: name, options: { executablePath } });
    } catch {
      /* Optional per-user installation. */
    }
  };
  await userBrowser('Google Chrome', 'Google Chrome');
  candidates.push({ label: 'Microsoft Edge', options: { channel: 'msedge' } });
  await userBrowser('Microsoft Edge', 'Microsoft Edge');
  for (const [index, candidate] of candidates.entries()) {
    checkCancelled();
    try {
      const browser = await chromium.launch({ ...options, ...candidate.options });
      if (index)
        warn(
          `Using installed ${candidate.label} in a fresh recording browser. Your existing browser login is not shared.`,
        );
      return browser;
    } catch (error) {
      checkCancelled();
      if (!missingBrowser(error)) throw error;
    }
  }
  throw new Error('TESTLOOM_BROWSER_MISSING');
}
