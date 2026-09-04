'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function serveHooks({ trusted = false } = {}) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const hooks = process.argv.filter((arg) => arg.startsWith('hooks.')).map((arg) => ({
      command: JSON.parse(arg.match(/command=("(?:\\.|[^"\\])*")/)[1]),
      source: 'sessionFlags', eventName: arg.split('=')[0], enabled: true,
      trustStatus: trusted || fs.existsSync(path.join(process.env.CODEX_HOME, 'trusted')) ? 'trusted' : 'untrusted',
    }));
    process.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'hooks/list'
      ? { data: [{ hooks, errors: [] }] } : {} }) + '\n');
  });
}

if (require.main === module) {
  if (process.argv[2] === 'app-server') serveHooks();
  else if (process.argv.includes('--version')) console.log('codex-test 1');
  else if (process.argv.includes('doctor')) console.log(JSON.stringify({ checks: { 'auth.credentials': { status: 'ok' } } }));
  else {
    const home = process.env.CODEX_HOME;
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, 'launches.jsonl'), JSON.stringify({
      args: process.argv.slice(2), review: process.env.CC_HOOK_REVIEW === '1', taskId: process.env.CC_TASK_ID,
    }) + '\n');
    console.log(process.env.CC_HOOK_REVIEW === '1' ? 'Hooks need review. Type approve and press Enter.' : 'fake codex ready');
    process.stdin.on('data', (data) => {
      if (process.env.CC_HOOK_REVIEW === '1' && data.toString().includes('approve')) {
        fs.writeFileSync(path.join(home, 'trusted'), 'approved in review');
        console.log('Tracking hooks trusted.');
      }
    });
    process.on('SIGTERM', () => { fs.writeFileSync(path.join(home, 'review-stopped'), 'yes'); process.exit(0); });
    process.on('SIGHUP', () => { fs.writeFileSync(path.join(home, 'review-stopped'), 'yes'); process.exit(0); });
  }
}

module.exports = { serveHooks };
