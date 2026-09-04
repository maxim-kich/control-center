# Automatic model discovery

Control Center refreshes the model catalog at startup and every hour. The browser
reads the cached catalog after restoring the workspace and every 30 seconds while
visible. Settings → Models → **Refresh models** requests an immediate refresh.
Neither bootstrap nor the catalog GET endpoint waits for CLI diagnostics or discovery.

- Codex: the configured Codex binary runs `app-server`; Control Center initializes
  the connection and paginates `model/list`. No thread or inference turn is started.
- Claude: the official Agent SDK calls `supportedModels()` against the configured
  installed Claude binary. The input stream sends no prompts. Session persistence,
  hooks, tools, and MCP connections are disabled for this discovery session.
- Discovery uses each launch adapter's environment filtering, so inherited agent
  runtime variables cannot break the CLI probe. Each provider has a 20-second timeout;
  one provider's failure does not prevent the other from updating.

Successful results are saved atomically to `CONTROL_CENTER_HOME/model-catalog.json`
(by default `~/.control-center/model-catalog.json`). The catalog includes model IDs,
display labels, descriptions, available effort levels, and provider defaults where
reported. The cache is scoped to the configured binary and credential/environment
identity; credentials themselves are never written into it. After a restart, cached
results are available immediately. A failed or empty refresh retains the last usable
list. The bundled lists are only a fallback before any successful discovery.

Existing tasks retain their model IDs and effort settings, including models no longer
in the discovered list. Discovery never upgrades existing tasks automatically.
`max` and `ultra` are preserved rather than mapped to `xhigh`; model capabilities
determine the effort choices in the task form. Claude aliases are kept exactly as
reported by the SDK, so an alias can resolve to a newer model over time.

Catalog membership is not a guarantee that a task can run: account access, provider
configuration, CLI versions and provider outages can still affect launches. Updating
the installed provider CLI may be necessary before it reports a newly released model.

API:

- `GET /api/models`: cached model configuration and per-provider freshness/error metadata.
- `POST /api/models/refresh`: wait for a bounded refresh, then return that same shape.
- `/api/bootstrap` and `/api/connections/models`: use the same catalog for their model lists.

References: [Codex App Server](https://learn.chatgpt.com/docs/app-server#models),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript).
