import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const html = fs.readFileSync(new URL('../src/public/app/dabbar-dashboard-full.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim());
if (!scripts.length) throw new Error('No inline scripts found');
for (const [index, script] of scripts.entries()) {
  const path = `/tmp/dabbar-dashboard-${index}.js`;
  fs.writeFileSync(path, script);
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}
console.log(`dashboard_scripts_ok count=${scripts.length}`);
