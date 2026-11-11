import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

export const ALLOWED_WITH_PAIRS = new Set([
  // Explicitly approved <base> WITH <exception> combinations
]);

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      i++;
    } else if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      i++;
    } else {
      const start = i;
      while (i < input.length && !/\s/.test(input[i]) && input[i] !== '(' && input[i] !== ')') {
        i++;
      }
      const word = input.slice(start, i);
      if (word === 'OR') {
        tokens.push({ type: 'OR', value: 'OR' });
      } else if (word === 'AND') {
        tokens.push({ type: 'AND', value: 'AND' });
      } else if (word === 'WITH') {
        tokens.push({ type: 'WITH', value: 'WITH' });
      } else if (/^[A-Za-z0-9_.\-+:]+$/.test(word)) {
        tokens.push({ type: 'IDENT', value: word });
      } else {
        return null;
      }
    }
  }
  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

export function isWithAllowed(
  base,
  exception,
  allowedSet = ALLOWED_LICENSES,
  allowedWithPairs = ALLOWED_WITH_PAIRS,
) {
  if (!allowedSet.has(base)) {
    return false;
  }
  const pair = `${base} WITH ${exception}`;
  return allowedWithPairs.has(pair);
}

export function isLicenseAllowed(
  licenseString,
  allowedSet = ALLOWED_LICENSES,
  allowedWithPairs = ALLOWED_WITH_PAIRS,
) {
  if (!licenseString || typeof licenseString !== 'string') {
    return false;
  }

  const tokens = tokenize(licenseString.trim());
  if (!tokens) {
    return false;
  }

  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function consume(expectedType) {
    const token = tokens[pos];
    if (!token || (expectedType && token.type !== expectedType)) {
      throw new Error(`Expected ${expectedType || 'token'}, got ${token ? token.type : 'EOF'}`);
    }
    pos++;
    return token;
  }

  function parseFactor() {
    const token = peek();
    if (!token) {
      throw new Error('Unexpected end of input');
    }
    if (token.type === 'LPAREN') {
      consume('LPAREN');
      const val = parseOr();
      consume('RPAREN');
      return val;
    }
    if (token.type === 'IDENT') {
      const base = consume('IDENT').value;
      if (peek().type === 'WITH') {
        consume('WITH');
        const exc = consume('IDENT').value;
        return isWithAllowed(base, exc, allowedSet, allowedWithPairs);
      }
      return allowedSet.has(base);
    }
    throw new Error(`Unexpected token: ${token.type}`);
  }

  function parseAnd() {
    let result = parseFactor();
    while (peek().type === 'AND') {
      consume('AND');
      const right = parseFactor();
      result = result && right;
    }
    return result;
  }

  function parseOr() {
    let result = parseAnd();
    while (peek().type === 'OR') {
      consume('OR');
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }

  try {
    const result = parseOr();
    if (peek().type !== 'EOF') {
      return false;
    }
    return result;
  } catch {
    return false;
  }
}

export function loadExceptions(exceptionsPath) {
  if (!existsSync(exceptionsPath)) {
    return {};
  }

  let raw;
  try {
    raw = readFileSync(exceptionsPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read exceptions file at "${exceptionsPath}": ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in license exceptions file "${exceptionsPath}": ${err.message}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(
      `License exceptions file "${exceptionsPath}" must contain a JSON object mapping package names to exception definitions.`,
    );
  }

  for (const [pkgName, entry] of Object.entries(data)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Invalid exception entry for "${pkgName}" in "${exceptionsPath}": entry must be an object.`,
      );
    }
    if (typeof entry.license !== 'string' || entry.license.trim().length === 0) {
      throw new Error(
        `Invalid exception entry for "${pkgName}" in "${exceptionsPath}": missing or empty "license" field.`,
      );
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      throw new Error(
        `Invalid exception entry for "${pkgName}" in "${exceptionsPath}": missing or empty "reason" field.`,
      );
    }
  }

  return data;
}

export function checkLicenses(
  licensesData,
  exceptions = {},
  allowedSet = ALLOWED_LICENSES,
  allowedWithPairs = ALLOWED_WITH_PAIRS,
) {
  const violations = [];
  let totalPackages = 0;

  for (const [license, packages] of Object.entries(licensesData)) {
    const allowed = isLicenseAllowed(license, allowedSet, allowedWithPairs);

    for (const pkg of packages) {
      totalPackages++;
      const name = pkg.name;
      const versions = pkg.versions || [pkg.version || 'unknown'];

      if (allowed) {
        continue;
      }

      // Check if package is an approved exception matching observed license with valid reason
      const exception = exceptions[name];
      if (
        exception &&
        exception.license === license &&
        typeof exception.reason === 'string' &&
        exception.reason.trim().length > 0
      ) {
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
    exceptions = loadExceptions(exceptionsPath);
  } catch (err) {
    console.error(`\n❌ Error loading license exceptions: ${err.message}\n`);
    return false;
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
      '\nIf an exception is required, add an entry with "license" and "reason" fields in tools/license-exceptions.json\n',
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
