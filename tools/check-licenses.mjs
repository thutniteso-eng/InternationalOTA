import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'MPL-2.0',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
]);

export function isLicenseAllowed(licenseString, allowedSet = ALLOWED_LICENSES) {
  if (!licenseString || typeof licenseString !== 'string') {
    return false;
  }
  const trimmed = licenseString.trim();
  if (allowedSet.has(trimmed)) {
    return true;
  }

  // Handle OR expressions: allowed if at least one choice is allowed
  if (trimmed.includes(' OR ')) {
    const parts = trimmed
      .replace(/[()]/g, '')
      .split(/\s+OR\s+/)
      .map((p) => p.trim());
    return parts.some((p) => isLicenseAllowed(p, allowedSet));
  }

  // Handle AND expressions: allowed only if all parts are allowed
  if (trimmed.includes(' AND ')) {
    const parts = trimmed
      .replace(/[()]/g, '')
      .split(/\s+AND\s+/)
      .map((p) => p.trim());
    return parts.every((p) => isLicenseAllowed(p, allowedSet));
  }

  // Strip enclosing parentheses e.g. "(MIT)"
  const unparenthesized = trimmed.replace(/^\((.*)\)$/, '$1').trim();
  if (unparenthesized !== trimmed) {
    return isLicenseAllowed(unparenthesized, allowedSet);
  }

  return false;
}

export function checkLicenses(licensesData, exceptions = {}, allowedSet = ALLOWED_LICENSES) {
  const violations = [];
  let totalPackages = 0;

  for (const [license, packages] of Object.entries(licensesData)) {
    const allowed = isLicenseAllowed(license, allowedSet);

    for (const pkg of packages) {
      totalPackages++;
      const name = pkg.name;
      const versions = pkg.versions || [pkg.version || 'unknown'];

      if (allowed) {
        continue;
      }

      // Check if package is an approved exception with a valid reason field
      const exception = exceptions[name];
      if (exception && typeof exception.reason === 'string' && exception.reason.trim().length > 0) {
        continue;
      }

      violations.push({
        name,
        versions: Array.isArray(versions) ? versions.join(', ') : String(versions),
        license,
      });
    }
  }

  return {
    valid: violations.length === 0,
    totalPackages,
    violations,
  };
}

export function run(options = {}) {
  const exceptionsPath = options.exceptionsPath || resolve('tools/license-exceptions.json');
  let exceptions = {};
  try {
    const raw = readFileSync(exceptionsPath, 'utf8');
    exceptions = JSON.parse(raw);
  } catch {
    exceptions = {};
  }

  let licensesData = options.licensesData;
  if (!licensesData) {
    const stdout = execSync('pnpm licenses list --json', {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    licensesData = JSON.parse(stdout);
  }

  const result = checkLicenses(licensesData, exceptions);

  if (!result.valid) {
    console.error(`\n❌ Found ${result.violations.length} packages with non-allowed licenses:\n`);
    for (const v of result.violations) {
      console.error(`  - ${v.name} (${v.versions}): ${v.license}`);
    }
    console.error(
      '\nIf an exception is required, add an entry with a "reason" field in tools/license-exceptions.json\n',
    );
    return false;
  }

  console.log(`✅ All ${result.totalPackages} package licenses verified successfully.`);
  return true;
}

// Run if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const success = run();
  if (!success) {
    process.exit(1);
  }
}
