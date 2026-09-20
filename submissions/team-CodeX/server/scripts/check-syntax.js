// Syntax-check every JS file (node --check) and validate package.json + env config.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d) => readdirSync(d).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.js') ? [join(d, f)] : []));
const files = [...walk('src'), ...walk('test'), ...walk('scripts')];
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    console.error(`SYNTAX ERROR ${f}\n${e.stderr}`);
  }
}
JSON.parse(readFileSync('package.json', 'utf8'));
const { buildConfig, configWarnings } = await import('../src/config.js');
const cfg = buildConfig({ PORT: '3000', REDIS_URL: 'redis://localhost:6379' });
console.log(`checked ${files.length} files, package.json valid, config valid (${configWarnings(cfg).length} warnings for empty env)`);
process.exit(bad ? 1 : 0);
