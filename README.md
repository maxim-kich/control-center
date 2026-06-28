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

Settings -> General can check for updates, run an update dry-run, apply an update, and rollback when a rollback ref exists. Before replacing app code, the updater refuses dirty image-owned files, refuses extension conflicts by default, backs up config and the SQLite database, and runs migrations against a copied database:

```bash
~/.control-center/bin/control-center update --dry-run
~/.control-center/bin/control-center update
~/.control-center/bin/control-center rollback
```

Development checkouts can pass a specific Git ref:

```bash
~/.control-center/bin/control-center update --target v0.1.1 --dry-run
```

Tagged pushes matching `v*` run the GitHub release workflow and attach the package artifact to the release after `npm run verify:release` passes.

## Extensions

User-owned extensions live outside the app checkout:

```text
~/.control-center/extensions/<extension-id>/
  extension.yaml
  server.js
  public/
  migrations/
```

The app discovers settings panels, task detail sections, project actions, declared migrations, static assets, and local API routes under `/api/extensions/<extension-id>/`. A copyable sample is in `examples/extensions/status-panel`.

Update and rollback commands scan extensions first. Duplicate extension IDs, route declarations, migration IDs, or UI slots stop the operation unless `--allow-extension-conflicts` is passed.

## Verify

```bash
npm test
npm run verify:public
npm run verify:release
```

`npm run verify:public` fails if generated/private files, planning notes, known private screenshots, or non-example absolute home paths are tracked or included in the package.

Optional diagnostics:

```bash
node scripts/auth_check.js
node scripts/e2e_test.js
```

These skip real Codex launches unless `CC_REAL_CODEX=1` is set.
