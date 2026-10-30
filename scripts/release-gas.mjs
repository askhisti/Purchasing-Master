import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveReleaseTarget } from './release-lib.mjs';

const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'apps-script', 'MasterData');
const claspExecutable = process.platform === 'win32'
  ? 'C:\\Users\\a.khisti\\AppData\\Roaming\\npm\\clasp.cmd'
  : 'clasp';

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
  const description = process.argv.slice(2).join(' ').trim();
  if (!description) {
    throw new Error('Usage: npm run release -- "<description>"');
  }
  const { deploymentId } = resolveReleaseTarget(
    readIfExists(path.join(targetDir, '.clasp.json')),
    readIfExists(path.join(rootDir, 'scripts', 'release-config.json'))
  );

  console.log('Running tests and validation...');
  execSync('npm test && npm run validate', { cwd: rootDir, stdio: 'inherit' });

  console.log('clasp push...');
  console.log(runClasp(['push', '--force'], targetDir));

  console.log('clasp version...');
  console.log(runClasp(['version', description], targetDir));

  console.log('clasp deploy...');
  console.log(runClasp(['deploy', '-i', deploymentId, '-d', description], targetDir));
}

try {
  main();
} catch (e) {
  console.error(`release failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
