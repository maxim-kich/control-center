'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');

function resolvePath(value, base = process.cwd()) {
  if (!value) return value;
  let out = String(value).trim();
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  return path.resolve(base, out);
}

function defaultAppHome() {
  return path.join(os.homedir(), '.control-center');
}

const APP_HOME = resolvePath(process.env.CONTROL_CENTER_HOME || process.env.CC_HOME || defaultAppHome());
const DATA_DIR = resolvePath(process.env.CC_DATA_DIR || path.join(APP_HOME, 'data'));
const BACKUP_DIR = resolvePath(process.env.CC_BACKUP_DIR || path.join(APP_HOME, 'backups'));
const EXTENSIONS_DIR = resolvePath(process.env.CC_EXTENSIONS_DIR || path.join(APP_HOME, 'extensions'));
const RELEASES_DIR = resolvePath(process.env.CC_RELEASES_DIR || path.join(APP_HOME, 'releases'));
const LOG_DIR = resolvePath(process.env.CC_LOG_DIR || path.join(APP_HOME, 'logs'));

function defaultWorkspaceRoot() {
  const documents = path.join(os.homedir(), 'Documents');
  try {
    if (fs.statSync(documents).isDirectory()) return documents;
  } catch {
    /* fall through */
  }
  return os.homedir();
}

function ensureRuntimeDirs() {
  for (const dir of [APP_HOME, DATA_DIR, BACKUP_DIR, EXTENSIONS_DIR, RELEASES_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  APP_ROOT,
  APP_HOME,
  DATA_DIR,
  BACKUP_DIR,
  EXTENSIONS_DIR,
  RELEASES_DIR,
  LOG_DIR,
  defaultAppHome,
  defaultWorkspaceRoot,
  ensureRuntimeDirs,
  resolvePath,
};
