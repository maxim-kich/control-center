## Slop-Disclaimer

It's a vibe coded experiment that helps me personally to control my coding agents according to my mental model. Use it as you wish. There is no contribution expected. And of course this readme was not meant to be read by humans, let your agent read and explain it for you.

# Control Center

Control Center is a local web app for managing AI coding tasks and launching real interactive provider CLIs in an embedded terminal. The current release supports Codex and Claude launches.

It binds to `127.0.0.1` and serves a live terminal. Do not expose it to a network.

## Quick Start

Prerequisites:

- Node.js 18 or newer with npm.
- At least one supported provider CLI installed and signed in: Codex or Claude.

Clone, install dependencies, and create the local `control-center` launcher:

```bash
git clone https://github.com/maxim-kich/control-center.git control-center
cd control-center
./scripts/install
~/.control-center/bin/control-center start
```

Open `http://127.0.0.1:3137`.

If you added `~/.control-center/bin` to `PATH`, the shorter start command also works:

```bash
control-center start
```

The examples below use `~/.control-center/bin/control-center` so they work immediately after install, even before updating your shell `PATH`.

For development, keep state out of the checkout and use a separate port:

```bash
CONTROL_CENTER_HOME=.dev-control-center PORT=3138 npm start
```

## macOS Dock Launcher

On macOS, Control Center can create a lightweight `.app` launcher that users can add to the Dock. This is not a separate native app; it starts or reuses the local Control Center server and opens the dashboard in the browser.

```bash
npm run macos-app
open "Control Center.app"
```

After opening it once, drag `Control Center.app` to the Dock for quick access.

The launcher keeps runtime state in `CONTROL_CENTER_HOME`, which defaults to `~/.control-center`, and logs startup details under `~/.control-center/logs/`.

## Runtime Layout

App code stays in the Git checkout or release directory. User state is written to `CONTROL_CENTER_HOME`, which defaults to `~/.control-center`.

```text
control-center/
  server.js
  lib/
  public/
  scripts/
  tests/

~/.control-center/
  config.yaml
  data/tasks.db
  backups/
  extensions/
  releases/
  logs/
```

## Configuration

- `CONTROL_CENTER_HOME=/path/to/home` changes the instance state root.
- `PORT=4000` changes the server port.
- `CC_WORKSPACE_ROOT=/path/to/workspace` changes the project-picker root.
- `CC_CODEX_BIN=/path/to/codex` overrides the Codex binary.
- `CC_DB_PATH=/path/to/tasks.db` overrides the SQLite database path.
- `CC_SKIP_PERMISSIONS=false` disables the default Codex build-mode YOLO launch.
- `CC_GRAPHIFY_ENABLED=false` disables project Graphify automation.
- `CC_GRAPHIFY_WATCH=false` disables recursive file watching for Graphify refreshes.

## Providers

Codex and Claude tasks launch real interactive CLI sessions through `node-pty`. Control Center does not use `codex exec`, Claude `--print`, SDK, or API-credit launch modes for task sessions.

Codex tracking hooks use Codex's saved hook trust. When approval is needed, starting,
resuming, or forking a task opens a separate approval modal containing Codex's native
review terminal. Review and trust the Control Center hooks there; the waiting action
continues automatically once all tracking hooks are trusted and enabled. Cancel
leaves the action pending without starting it. The review session creates no Control
Center task or tracking records, and closes when the modal closes.

Hook approval is independent of YOLO. Control Center never adds
`--dangerously-bypass-hook-trust`. Trust checks require a Codex version supporting
the app-server `hooks/list` method (verified with 0.153.2); unsupported APIs or failed
checks stop the launch with an error. Codex stores trust for the exact hook definition,
so changed definitions or paths can require another review. Other project or plugin
hooks retain Codex's normal review behavior. Control Center does not edit trust files.

Claude launches use generated hook settings under `CONTROL_CENTER_HOME` and strip Anthropic API-token environment variables from child sessions so the Claude CLI uses the user's normal subscription auth.

## Import

Legacy Control Center databases can be imported without copying runtime files:

```bash
~/.control-center/bin/control-center import --from /path/to/old/CONTROL_CENTER --source-provider claude
~/.control-center/bin/control-center import --from /path/to/old/CONTROL_CENTER --source-provider codex
```

The importer reads `data/tasks.db`, maps rows into the current schema, and does not copy `node_modules`, generated provider settings, uploads, auth artifacts, or `graphify-out`.

## Updates

Release checks use GitHub releases. Configure the repository explicitly when the checkout remote is not a GitHub repo:

```bash
export CC_UPDATE_REPO=maxim-kich/control-center
~/.control-center/bin/control-center check-updates
```

Settings -> General can check for updates, run an update dry-run, apply an update, and rollback when a rollback ref exists. Before switching releases, the updater replaces image-owned application files, preserves user-owned extensions and instance state, refuses extension conflicts by default, backs up config and the SQLite database, and runs migrations against a copied database:

```bash
~/.control-center/bin/control-center update --dry-run
~/.control-center/bin/control-center update
~/.control-center/bin/control-center rollback
```

Development checkouts can pass a specific Git ref:

```bash
~/.control-center/bin/control-center update --target v0.1.2 --dry-run
```

Tagged pushes matching `v*` run the GitHub release workflow and attach the package artifact to the release after `npm run verify:release` passes.

## Extensions

User-owned extensions live outside the app checkout:

```text
~/.control-center/extensions/<extension-id>/
  extension.json
  server.js
  public/
  migrations/
```

The app discovers settings panels, task detail sections, project fields, project and task actions, badges, modals, lifecycle hooks, declared migrations, static assets, and local API routes under `/api/extensions/<extension-id>/`. Static frontend assets are served only from `/extensions/<extension-id>/` and are loaded by the core runtime only when declared in the manifest.

Rich UI extensions should use `extension.json` with explicit permissions:

```json
{
  "id": "sample-extension",
  "permissions": ["ui:frontend", "ui:project-fields", "ui:project-actions", "api:extension-state"],
  "frontend": {
    "scripts": [{ "path": "inline-ui.js" }],
    "styles": [{ "path": "inline-ui.css" }]
  },
  "contributes": {
    "projectFields": [{ "id": "important-project", "title": "Important project" }],
    "projectActions": [{ "id": "view-details", "title": "View details" }]
  }
}
```

Extension scripts register handlers through `window.ControlCenterExtensions.register(<id>, handlers)`. Extension-owned state is stored through `/api/extensions/<extension-id>/state` and is scoped by extension id, scope type, scope id, and key, so extensions do not need core project columns. Extension examples are maintained in the source repository and are not included in release packages.

The [extension development guide](docs/extensions/development.md) documents manifests, routes, frontend assets, UI contributions, storage, hooks, migrations, conflicts, update boundaries, and tests.

Backend extensions can declare provider-neutral lifecycle hooks with the `hooks:lifecycle` permission:

```json
{
  "permissions": ["hooks:lifecycle", "api:extension-state"],
  "hooks": {
    "task.completed": { "order": 100, "timeoutMs": 2000 },
    "project.metadata": { "order": 100 },
    "git.autoCommitPolicy": { "order": 100 }
  }
}
```

Export matching handlers from `server.js` as `exports.hooks`. Handlers receive a normalized event context containing Control Center task, project, previous-value, patch, and provider data, plus a scoped capability API with extension state and logging. Supported hooks are `app.started`, `app.stopping`, `task.statusChanged`, `task.completed`, `project.created`, `project.updated`, `project.archived`, `project.unarchived`, `project.deleted`, `project.metadata`, `git.autoCommitPolicy`, `update.checking`, `update.checked`, `migration.before`, and `migration.after`.

Hooks run serially by ascending `order`, then extension ID. The default timeout is five seconds and failures are isolated and reported in Settings. Notification and metadata failures are fail-open. Auto-commit policy handlers return `allow`, `deny`, or `abstain`; deny wins, and contradictory allow/deny decisions are reported as conflicts.

Backend extension code is trusted code loaded in the Control Center Node.js process. Install only extensions whose source you trust. Lifecycle handlers receive scoped capabilities, but frontend assets and optional route modules are not sandboxed.

Install extensions from `Settings -> Extensions -> Install extension` by choosing an extension folder or entering a GitHub/Git URL. GitHub tree URLs can point at a subfolder, and the installer copies the detected extension into `~/.control-center/extensions/<extension-id>/`. Frontend-only extensions become available after the install refresh; extensions with `server.js` may need a restart before their local API routes are active.

First-party optional extensions can also ship inside the application image under `bundled-extensions/`. Control Center catalogs those folders without network access, copies a selected bundle into the instance-owned extensions directory, keeps it disabled until explicitly enabled, compares semantic versions for upgrades, and retains the immediately previous bundle for file rollback. Enablement, installed versions, applied migration IDs, and rollback metadata persist in the instance database. SQL migrations run transactionally and require `migrations:run`; rolling back extension files does not reverse an already-applied data migration.

Managed backend permissions are `git:read`, `git:write`, `process:managed`, `providers:setup`, `health:checks`, and `migrations:run`. Side-effecting managed calls additionally require an `ownership:<domain>` permission and a matching `ownership` declaration; ownership extensions must include a backend and health-check permission. The compatibility domains in this release are `graphify` and `git`. Each domain has one persisted preferred owner and one active owner; `legacy` is the default and automatic fallback when the preferred extension is disabled, missing, invalid, duplicated, or unhealthy. The legacy Graphify and Git paths check this active owner before every side effect, so core and an extension cannot both write the same domain. The catalog, permission decisions, ownership/fallback state, health results, and managed process status are visible at `/api/extensions/diagnostics` and in `/api/health`.

This release package includes only the first-party bundled `graphify` and `git-workflow` extensions. Development examples and other extensions are not shipped in the build. The updater performs a read-only usage inspection, persists a migration plan, backs up the database/configuration, installs the bundles offline, imports compatibility state into `extension_state`, validates health, then switches ownership only for domains with prior usage. Failed migration attempts record a ledger and leave the legacy owner active. The post-update introduction screen is keyed by app version and can be reopened from Settings -> General -> Version -> Integration notes.

The legacy Graphify and Git implementations are intentionally retained for one release as fallback owners. They should be removed only after a later release has telemetry or support evidence that migration, rollback, and re-update are stable, compatibility API consumers have moved off legacy-only assumptions, and the release notes have announced the removal boundary.

Update and rollback commands scan extensions first. Duplicate extension IDs, route declarations, migration IDs, or UI slots stop the operation unless `--allow-extension-conflicts` is passed.

## Verify

```bash
npm test
npm run verify:public
npm run verify:release
```

`npm run verify:public` fails if generated/private files, planning notes, known private screenshots, or non-example absolute home paths are tracked or included in the package.

`npm run verify:release` is the mandatory publication command. It runs the full test suite, public verification, bundled-migration dry-run fixture, and the isolated previous-version update/startup migration/rollback/re-update smoke. A failure in any smoke phase blocks release. Set `CC_SMOKE_KEEP=1` to retain the isolated fixture for diagnosis. In a clean release checkout with update targets configured, `CC_RELEASE_GATE_UPDATE_SMOKE=1` and `CC_RELEASE_GATE_ROLLBACK_SMOKE=1` additionally exercise the environment's configured updater targets.

`npm run smoke:release` builds a temporary release remote from `v0.1.0` and the current working tree, creates a previous-schema `CONTROL_CENTER_HOME`, and drives the real updater through update, startup migration, rollback, legacy restart, and re-update. It never updates the development checkout. Set `CC_SMOKE_PREVIOUS_REF` to test another previous release or `CC_SMOKE_KEEP=1` to retain the isolated fixture for debugging.

Optional diagnostics:

```bash
node scripts/auth_check.js
node scripts/e2e_test.js
```

These skip real Codex launches unless `CC_REAL_CODEX=1` is set.

## License

MIT. See [LICENSE](LICENSE).
