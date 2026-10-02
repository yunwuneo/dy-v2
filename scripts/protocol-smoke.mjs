import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';

if (!process.argv.includes('--confirm-paid')) throw new Error('Use --confirm-paid to authorize real API calls');
const identifier = config.watchers[0]?.identifier;
if (!identifier) throw new Error('Configure a watcher first');
const childRun = (args, input, expectedResponses = 0) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', './scripts/live-budget.mjs', ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Protocol smoke timed out')); }, 90000);
  child.stdout.on('data', chunk => {
    output += chunk;
    if (expectedResponses && output.trim().split('\n').length >= expectedResponses) child.stdin.end();
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(`Child failed (${code}): ${errors.slice(-500)}`)); });
  if (input) child.stdin.write(input); else child.stdin.end();
});
const cli = JSON.parse(await childRun(['src/cli.js', 'list', identifier, '--limit', '1']));
assert.equal(cli.length, 1);
console.log('CLI live list: passed');
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_videos', arguments: { identifier, limit: 1 } } },
];
const output = await childRun(['src/mcp.js'], messages.map(m => JSON.stringify(m)).join('\n') + '\n', 3);
const responses = output.trim().split('\n').map(line => JSON.parse(line));
assert.equal(responses.find(r => r.id === 2).result.tools.length, 4);
const call = responses.find(r => r.id === 3);
assert.equal(call.result.isError, false);
assert.equal(JSON.parse(call.result.content[0].text).length, 1);
console.log('MCP initialize, tools/list and live tools/call: passed (clean JSON-RPC stdout)');
