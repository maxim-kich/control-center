'use strict';

const OWNERSHIP_DOMAINS = new Set(['graphify', 'git']);

const MANAGED_PERMISSIONS = new Set([
  'git:read',
  'git:write',
  'process:managed',
  'providers:setup',
  'health:checks',
  'migrations:run',
  ...Array.from(OWNERSHIP_DOMAINS, (domain) => `ownership:${domain}`),
]);

function normalizeOwnership(raw) {
  const value = raw.ownership || raw.owns || [];
  const items = Array.isArray(value) ? value : Object.keys(value || {}).filter((key) => value[key]);
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function validateOwnership(ownership, permissions) {
  const errors = [];
  for (const domain of ownership || []) {
    if (!OWNERSHIP_DOMAINS.has(domain)) {
      errors.push(`unknown ownership domain ${domain}`);
      continue;
    }
    if (!(permissions || []).includes(`ownership:${domain}`)) {
      errors.push(`missing permission ownership:${domain} for ownership ${domain}`);
    }
  }
  return errors;
}

module.exports = {
  MANAGED_PERMISSIONS,
  OWNERSHIP_DOMAINS,
  normalizeOwnership,
  validateOwnership,
};
