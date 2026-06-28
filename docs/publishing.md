# Publishing Checklist

Before tagging a release:

1. Run `npm test`.
2. Run `npm run verify:public`.
3. Run `npm run update:dry-run` against a copied or disposable instance database when validating an update build.
4. Start a dev instance with isolated state:

   ```bash
   CONTROL_CENTER_HOME=.dev-control-center PORT=3138 npm start
   ```

5. Confirm Settings reports the expected version, install path, data path, update channel, latest release status, and rollback ref.
6. Confirm no generated/runtime files are staged:

   ```bash
   git status --short
   git ls-files 'PLAN.md' 'plan.md' 'docs/screenshot.png' 'graphify-out/**' 'data/**' 'USER_UPLOADS/**' '.env*' '.claude/**' '.codex/**' '*.db' '*.db-wal' '*.db-shm'
   ```

7. Scan the full public history before the first push or any history rewrite:

   ```bash
   git grep -n -I -E '/Users/|BEGIN .*PRIVATE KEY|github_pat_|ghp_|sk-[A-Za-z0-9_-]{20,}' $(git rev-list --all) -- . ':(exclude)package-lock.json'
   git log --all --name-only --pretty=format: | sort -u | grep -E '(^|/)PLAN\.md$|graphify-out|USER_UPLOADS|\.codex|\.env|\.db'
   ```

8. For migration builds, run imports against copied legacy databases only.
9. Confirm CI passes `npm run verify:release` on the release branch before tagging.
10. Check Settings -> Extensions or `/api/extensions`; resolve extension conflicts before update/rollback unless the release notes explicitly say to pass `--allow-extension-conflicts`.

To publish:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag workflow runs `npm ci`, `npm run verify:release`, builds `control-center-<version>.tgz`, and attaches it to the GitHub Release with generated notes.

Current release scope:

- Codex launch is supported.
- Claude launch is adapter-backed and uses generated instance-owned hook settings.
- Update checks, update dry-runs, update apply, and rollback are available from Settings and the CLI. The in-app apply/rollback path refuses active terminal sessions unless forced at the API level, then restarts the local server after a successful code switch.
- Extensions are discovered from instance-owned state and conflict-scanned before update/rollback.
