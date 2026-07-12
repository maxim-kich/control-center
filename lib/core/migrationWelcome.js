'use strict';

const COMPLETED_KEY = 'updates.bundled_integration_welcome.completed_version';
const PLAN_KEY = 'updates.bundled_integration_migration.plan.v1';
const LEDGER_KEY = 'updates.bundled_integration_migration.ledger.v1';

function readJsonMeta(db, key, fallback = null) {
  try {
    const raw = db.getMetaValue(key, '');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function targetSummary(plan, diagnostics) {
  const targets = plan && plan.targets || {};
  const ownership = diagnostics && diagnostics.ownership || {};
  return ['graphify', 'git'].map((domain) => {
    const target = targets[domain] || {};
    const state = ownership[domain] || {};
    return {
      domain,
      extensionId: target.extensionId || (domain === 'git' ? 'git-workflow' : domain),
      priorOwner: target.priorOwner || 'legacy',
      targetOwner: target.targetOwner || 'legacy',
      activeOwner: state.activeOwner || target.targetOwner || 'legacy',
      fallbackReason: state.fallbackReason || null,
      affectedProjects: Array.isArray(target.affectedProjectIds) ? target.affectedProjectIds.length : 0,
      used: !!target.used,
    };
  });
}

function chooseVariant(plan, ledger, diagnostics) {
  const targets = targetSummary(plan, diagnostics);
  const hasFallback = targets.some((target) => target.fallbackReason || (target.targetOwner !== 'legacy' && target.activeOwner === 'legacy'));
  if (ledger && ledger.status === 'failed') return hasFallback ? 'fallback' : 'partial-failure';
  if (hasFallback) return 'fallback';
  if (ledger && ledger.status === 'completed' && targets.some((target) => target.targetOwner !== 'legacy')) return 'migrated';
  if (plan && plan.newUser) return 'new-install';
  if (plan && plan.noOp) return 'no-usage';
  return 'discovery';
}

function copyForVariant(variant) {
  if (variant === 'migrated') {
    return {
      title: 'Bundled integrations are ready',
      body: 'Graphify and Git Workflow were moved into bundled extensions. Your projects and compatibility fields were preserved.',
      primary: 'Continue',
    };
  }
  if (variant === 'partial-failure' || variant === 'fallback') {
    return {
      title: 'Previous integrations are still active',
      body: 'Automatic migration did not complete. Control Center is using the previous integration path so projects remain usable.',
      primary: 'Continue with previous integration',
      secondary: 'Retry migration',
    };
  }
  if (variant === 'new-install') {
    return {
      title: 'Bundled integrations available',
      body: 'Graphify and Git Workflow are available as optional bundled extensions for project graphs and task commits.',
      primary: 'Continue',
    };
  }
  if (variant === 'no-usage') {
    return {
      title: 'New bundled integrations available',
      body: 'Graphify and Git Workflow are available from Settings. No previous integration usage was found on this installation.',
      primary: 'Continue',
    };
  }
  return {
    title: 'Bundled integrations available',
    body: 'Graphify and Git Workflow can be enabled from Settings when you want project graphs or task commits.',
    primary: 'Continue',
  };
}

function buildMigrationWelcomeState(opts = {}) {
  const appVersion = String(opts.appVersion || 'dev');
  const welcomeVersion = `bundled-integrations:${appVersion}`;
  const plan = opts.plan || null;
  const ledger = opts.ledger || null;
  const diagnostics = opts.diagnostics || {};
  const completedVersion = opts.completedVersion || null;
  const variant = chooseVariant(plan, ledger, diagnostics);
  const copy = copyForVariant(variant);
  const targets = targetSummary(plan, diagnostics);
  return {
    version: welcomeVersion,
    completedVersion,
    show: !!opts.force || completedVersion !== welcomeVersion,
    variant,
    title: copy.title,
    body: copy.body,
    primaryAction: copy.primary,
    secondaryAction: copy.secondary || null,
    canRetry: variant === 'partial-failure' || variant === 'fallback',
    canContinuePrevious: variant === 'partial-failure' || variant === 'fallback',
    targets,
    details: {
      ledgerStatus: ledger && ledger.status || null,
      ledgerError: ledger && ledger.error || null,
      planCreatedAt: plan && plan.createdAt || null,
      noOp: !!(plan && plan.noOp),
      newUser: !!(plan && plan.newUser),
    },
  };
}

function migrationWelcomeStateFromDb(opts = {}) {
  const db = opts.db;
  const plan = opts.plan || readJsonMeta(db, PLAN_KEY, null);
  const ledger = opts.ledger || readJsonMeta(db, LEDGER_KEY, null);
  const completedVersion = db.getMetaValue(COMPLETED_KEY, null);
  return buildMigrationWelcomeState({
    appVersion: opts.appVersion,
    diagnostics: opts.diagnostics,
    force: opts.force,
    plan,
    ledger,
    completedVersion,
  });
}

function markMigrationWelcomeComplete(db, version) {
  db.setMetaValue(COMPLETED_KEY, version);
  return db.getMetaValue(COMPLETED_KEY, null);
}

module.exports = {
  COMPLETED_KEY,
  PLAN_KEY,
  LEDGER_KEY,
  buildMigrationWelcomeState,
  migrationWelcomeStateFromDb,
  markMigrationWelcomeComplete,
};
