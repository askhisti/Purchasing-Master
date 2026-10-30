// Push-only release (R55): npm test && npm run validate -> clasp push --force -> optional clasp version.
// Usage: npm run release [-- "<version description>"]
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveReleaseTarget, optionalDescription } from './release-lib.mjs';

const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'apps-script', 'MasterData');
const claspExecutable = process.env.CLASP_PATH || (process.platform === 'win32'
  ? 'C:\Users\a.khisti\AppData\Roaming\npm\clasp.cmd'
  : 'clasp');

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function runClasp(args, cwd) {
  const escapedArgs = args.map(arg => (/[\s"]/u.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
  return execSync([claspExecutable, ...escapedArgs].join(' '), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function main() {
  const description = optionalDescription(process.argv.slice(2).join(' '));
  const { scriptId } = resolveReleaseTarget(readIfExists(path.join(targetDir, '.clasp.json')));

  console.log(`scriptId: ${scriptId}`);
  console.log('Running tests and validation...');
  execSync('npm test && npm run validate', { cwd: rootDir, stdio: 'inherit' });

  console.log('clasp push...');
  console.log(runClasp(['push', '--force'], targetDir));

  if (description) {
    console.log('clasp version...');
    console.log(runClasp(['version', description], targetDir));
  }
}

try {
  main();
} catch (e) {
  console.error(`release failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
