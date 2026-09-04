import { query } from '@anthropic-ai/claude-agent-sdk';

let release;
const held = new Promise((resolve) => { release = resolve; });
async function* noPrompts() { await held; }
let session;
try {
  session = query({
    prompt: noPrompts(),
    options: {
      pathToClaudeCodeExecutable: process.argv[2],
      cwd: process.cwd(),
      persistSession: false,
      settingSources: ['user'],
      settings: { disableAllHooks: true },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
    },
  });
  const models = await session.supportedModels();
  process.stdout.write(JSON.stringify(models));
} catch {
  process.exitCode = 1;
} finally {
  session?.close();
  release();
}
