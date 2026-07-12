# Building Control Center extensions

Control Center customizations are called **extensions**. Build ordinary user features as extensions instead of changing image-owned application files. This keeps updates safe and makes the feature installable, disableable, testable, and removable.

Use this layout:

```text
my-extension/
  extension.json
  server.js                 # optional trusted backend
  public/                   # optional browser assets
    main.js
    main.css
    settings.html
  migrations/               # optional versioned SQL
    001-initial.sql
  test/                      # extension-owned tests
```

Install the folder into `CONTROL_CENTER_HOME/extensions/<extension-id>/` (normally `~/.control-center/extensions/<extension-id>/`) through Settings -> Extensions. Do not put runtime state, credentials, generated output, or user uploads in the extension folder: installed extension files may be replaced during an upgrade.

## 1. Declare the manifest

Prefer `extension.json`. `extension.yaml` and `extension.yml` support only the small YAML subset accepted by the loader and are less suitable for rich contributions.

```json
{
  "apiVersion": 1,
  "id": "example-publisher",
  "name": "Example Publisher",
  "version": "0.1.0",
  "description": "Publishes project snapshots.",
  "server": "server.js",
  "permissions": [
    "ui:frontend",
    "ui:project-fields",
    "ui:project-actions",
    "ui:project-badges",
    "api:extension-state",
    "hooks:lifecycle"
  ],
  "frontend": {
    "scripts": [{ "path": "main.js" }],
    "styles": [{ "path": "main.css" }]
  },
  "contributes": {},
  "routes": [],
  "hooks": {},
  "migrations": []
}
```

The ID must match `^[a-z][a-z0-9-]{1,63}$`. Treat it as permanent: it scopes URLs, persisted state, diagnostics, and conflicts. Increment `version` when shipped assets change so browser cache keys change too.

Declare the narrowest permissions required. Frontend assets need `ui:frontend`; each rich contribution needs its matching `ui:*` permission; state needs `api:extension-state`; lifecycle hooks need `hooks:lifecycle`. Backend modules are trusted code loaded into the Control Center Node.js process. Permissions document and gate platform capabilities, but do not make arbitrary backend or frontend code a security sandbox.

## 2. Register backend routes

Export `register` from `server.js` and return an Express router:

```js
exports.register = function register({ express, extension, extensionDir, capabilities, db }) {
  const router = express.Router();
  router.get('/status', (req, res) => res.json({ extension: extension.id, ok: true }));
  return router;
};
```

Declare every public route in the manifest as `{ "method": "GET", "path": "status" }`. It mounts at `/api/extensions/<extension-id>/status`. The `state` first path segment is reserved for the platform state API. Validate all request bodies, keep routes extension-relative, return explicit status codes, and never accept an arbitrary filesystem path unless it resolves to the project the user selected.

Extension backends may need a Control Center restart after install or upgrade. Do not retain important state only in module globals.

## 3. Serve browser assets and contribute UI

Only files below `public/` are served, at `/extensions/<extension-id>/...`. Assets are loaded only when listed under `frontend.scripts` or `frontend.styles` and the extension has `ui:frontend`.

Register browser handlers with the exact manifest ID:

```js
window.ControlCenterExtensions.register('example-publisher', {
  projectActions: {
    publish: {
      render(ctx) {
        return ctx.h('button', { type: 'button', onclick: () => publish(ctx) }, 'Publish');
      }
    }
  }
});
```

Available manifest contribution collections are:

- `settingsPanels`: HTML pages displayed in Settings.
- `taskDetailSections`: task-detail content.
- `projectFields`: fields rendered in the project form; handlers can implement `render(ctx)` and `save(ctx)`.
- `projectActions` and `taskActions`: contextual commands.
- `projectBadges` and `taskBadges`: compact status indicators.
- `panels`: extension panels.
- `modals`: declarations used by registered handlers.

Each item needs a stable `id`, user-facing `title`, and appropriate `slot`. Use `ctx.api.getState`, `setState`, `deleteState`, `get`, and `send` instead of reaching into core APIs. Render with `ctx.h`; do not overwrite host globals or assume undocumented DOM structure.

## 4. Store extension-owned state

The built-in state API stores JSON by `(extension id, scope type, scope id, key)`. Scopes are `global`, `project`, and `task`.

```js
await ctx.api.setState('project', project.id, { enabled: true });
const state = await ctx.api.getState('project', project.id);
```

Lifecycle handlers receive the equivalent `api.state` capability. Prefer this storage for configuration, checkpoints, remote IDs, and small histories. Never add extension fields to core project/task tables. Keep secrets out of manifests, frontend state, logs, and source control; prefer environment variables or an approved secret provider. If an extension needs large files, put them under `CONTROL_CENTER_HOME` in an extension-namespaced directory, not in the checkout.

## 5. Add lifecycle hooks

Declare hooks and export matching handlers:

```json
"hooks": {
  "task.completed": { "order": 100, "timeoutMs": 2000 },
  "project.metadata": { "order": 100, "timeoutMs": 2000 }
}
```

```js
exports.hooks = {
  'task.completed'(context, api) {},
  'project.metadata'(context, api) { return { label: 'Ready' }; }
};
```

Supported hooks are `app.started`, `app.stopping`, `task.statusChanged`, `task.completed`, `project.created`, `project.updated`, `project.archived`, `project.unarchived`, `project.deleted`, `project.metadata`, `git.autoCommitPolicy`, `update.checking`, `update.checked`, `migration.before`, and `migration.after`.

Hooks run serially by ascending `order`, then extension ID. The default timeout is five seconds and the maximum is thirty seconds. Notification, enrichment, and metadata failures are isolated. `git.autoCommitPolicy` returns `allow`, `deny`, or `abstain`; deny wins. Make handlers idempotent because events can be retried or observed after an update.

## 6. Add migrations only when state is insufficient

Declare migrations with globally unique, immutable IDs:

```json
"migrations": [{ "id": "example-publisher-001", "path": "migrations/001-initial.sql" }]
```

SQL migrations require `migrations:run`, run transactionally, and are recorded after success. Use additive changes: create namespaced tables/indexes or add compatible columns; never drop/recreate core tables. Test migrations against database copies. File rollback does not reverse an already-applied data migration, so every older compatible extension version must tolerate the migrated schema.

Do not create a table merely to demonstrate migrations. If an extension's data fits the scoped `extension_state` contract, keep it there.

## 7. Understand conflicts and ownership

Scanning reports and update/rollback refuses these conflicts by default:

- duplicate extension IDs;
- duplicate route declarations for the same extension ID, method, and path;
- duplicate migration IDs across extensions;
- duplicate UI keys composed from contribution kind, slot, and item ID.

Use namespaced migration and contribution IDs. Do not rely on `--allow-extension-conflicts` in normal installation or release procedures.

The managed ownership domains (`graphify` and `git`) exist only for compatibility extensions replacing core behavior. Ordinary extensions must not declare ownership. If an ownership extension is necessary, it needs the matching `ownership:<domain>` permission, managed capabilities, health checks, explicit user selection, and a safe legacy fallback.

## 8. Keep updates safe

- Treat the application checkout and bundled extensions as image-owned and read-only.
- Put user configuration and state under `CONTROL_CENTER_HOME`; operate on a user-selected project only after explicit opt-in.
- Never hardcode absolute local paths.
- Do not edit SQLite files directly.
- Stage generated artifacts in an extension-owned runtime directory or the OS temporary directory and clean them up.
- Refuse symlinks or resolved paths that escape the selected project when creating snapshots.
- Exclude credentials, `.git`, dependency caches, Control Center runtime folders, and extension-specific ignore patterns from uploads.
- Make remote side effects explicit, retry-safe, and observable. Record success only after the remote service confirms it.

## 9. Test the extension

At minimum, test manifest normalization, permissions, route behavior, disabled behavior, lifecycle handlers, state scoping, conflicts, migrations, path traversal, update safety, and remote failures. Inject network/process adapters and use temporary project and `CONTROL_CENTER_HOME` directories. Assert that a publish or migration does not change image-owned files.

For repository changes, run focused tests first, then:

```sh
npm test
npm run verify:public
```

The source repository contains development-only examples with copyable patterns; examples are excluded from published release packages.
