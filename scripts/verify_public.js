#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function gitFiles(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function matchesForbidden(file) {
  return [
    /(?:^|\/)PLAN\.md$/i,
    /(?:^|\/)plan(?: \(\d+\))?\.md$/i,
    /^docs\/screenshot\.png$/,
    /^data\//,
    /^USER_UPLOADS\//,
    /^graphify-out\//,
    /^node_modules\//,
    /^Control Center\.app\//,
    /^\.codex\//,
    /^\.claude\/settings\.json$/,
    /^\.claude\/settings\.local\.json$/,
    /^\.claude\/mcp\.graph\..*\.json$/,
    /^\.codex\/hooks\.json$/,
    /^\.env(?:\.|$)/,
    /\.db(?:-|$)/,
    /\.db-wal$/,
    /\.db-shm$/,
  ].some((re) => re.test(file));
}

const tracked = gitFiles(['ls-files']);
const generatedTracked = tracked.filter((file) => matchesForbidden(file) && fs.existsSync(path.join(ROOT, file)));

const textFiles = tracked.filter((file) => {
  if (matchesForbidden(file)) return false;
  const full = path.join(ROOT, file);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const buf = fs.readFileSync(full);
    return !buf.includes(0);
  } catch {
    return false;
  }
});

const personalMatches = [];

const personalPatterns = [
  {
    label: 'absolute macOS home path',
    re: /\/Users\/(?!me(?:\/|\b)|you(?:\/|\b)|example(?:\/|\b)|runner(?:\/|\b))[^\s'"`)<>|]+/g,
  },
  {
    label: 'absolute Windows home path',
    re: /[A-Z]:\\Users\\(?!me(?:\\|\b)|you(?:\\|\b)|example(?:\\|\b)|runneradmin(?:\\|\b))[^\\\s'"`)<>]+/gi,
  },
  {
    label: 'private key marker',
    re: /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/g,
  },
  {
    label: 'likely access token',
    re: /\b(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g,
  },
];

function scanPersonalPaths(files, label) {
  for (const file of files) {
    const full = path.join(ROOT, file);
    let text;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of personalPatterns) {
        pattern.re.lastIndex = 0;
        if (pattern.re.test(line)) {
          personalMatches.push(`${label}:${file}:${index + 1}:${pattern.label}:${line.trim()}`);
          break;
        }
      }
    });
  }
}

scanPersonalPaths(textFiles, 'tracked');

let packageForbidden = [];
let packageFiles = [];
try {
  const packRaw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pack = JSON.parse(packRaw);
  packageFiles = ((pack[0] && pack[0].files) || []).map((item) => item.path).filter(Boolean);
  packageForbidden = packageFiles.filter(matchesForbidden);
  scanPersonalPaths(packageFiles.filter((file) => !matchesForbidden(file)), 'package');
} catch (e) {
  console.error('Could not inspect npm package contents:');
  console.error(e && e.stderr ? String(e.stderr).trim() : e.message);
  process.exit(1);
}

if (generatedTracked.length || personalMatches.length || packageForbidden.length) {
  if (generatedTracked.length) {
    console.error('Tracked generated/private files:');
    for (const file of generatedTracked) console.error(`  ${file}`);
  }
  if (packageForbidden.length) {
    console.error('Generated/private files in package dry-run:');
    for (const file of packageForbidden) console.error(`  ${file}`);
  }
  if (personalMatches.length) {
    console.error('Private-looking content found:');
    for (const match of personalMatches) console.error(`  ${match}`);
  }
  process.exit(1);
}

console.log(`Public verification passed (${tracked.length} tracked files scanned, ${packageFiles.length} package files checked).`);
