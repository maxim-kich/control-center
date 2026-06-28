## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## publishing guardrails

- Treat this repository as image-owned app code. Runtime state belongs under `CONTROL_CENTER_HOME` or `~/.control-center`, not in the checkout.
- Normal user features should live in extensions or user projects unless they are core app behavior.
- Never commit `PLAN.md`, `plan.md`, personal screenshots, `data/`, `USER_UPLOADS/`, `graphify-out/`, `.env*`, generated `.claude/` settings, generated `.codex/` files, DB files, DB sidecars, or auth artifacts.
- Never hardcode absolute local paths. Use `CONTROL_CENTER_HOME`, `CC_WORKSPACE_ROOT`, or a user-selected project path.
- Do not directly edit SQLite database files. Add migrations/importers and test them against copies.
- Updater work must refuse dirty image-owned files and dry-run migrations against database copies before switching code.
- Before release, run `npm test` and `npm run verify:public`.
