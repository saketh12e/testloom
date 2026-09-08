import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { prepareRecordingBrowser } from './prepare-recording-browser.mjs';

const require = createRequire(import.meta.url);
const app = require('../package.json');
const [target, ...args] = process.argv.slice(2);
if (process.platform !== 'darwin' || !['zip', 'dir'].includes(target))
  throw new Error('Build Mac releases on macOS with target zip or dir.');
if (args.includes('--universal') || (args.includes('--arm64') && args.includes('--x64')))
  throw new Error('Build each Mac architecture separately so its browser matches.');
const arch = args.includes('--x64') ? 'x64' : args.includes('--arm64') ? 'arm64' : process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Mac architecture.');
function run(script, parameters) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...parameters], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Mac build step failed (${signal || code}).`)),
    );
  });
}
await prepareRecordingBrowser({
  arch,
  output: path.resolve(`work/recording-browser-${app.version}-${arch}`),
});
await run('scripts/build.mjs', []);
await run(require.resolve('electron-builder/cli.js'), [
  '--mac',
  target,
  `--${arch}`,
  '--publish',
  'never',
  ...args.filter((arg) => !['--arm64', '--x64'].includes(arg)),
]);
