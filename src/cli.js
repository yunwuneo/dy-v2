#!/usr/bin/env node
import { config } from './config.js';
import { log } from './logger.js';
import { queryUser, listVideos, downloadSingle, downloadVideos, VALID_TYPES } from './tasks.js';
import { startPoller } from './poller.js';

const HELP = `抖音视频下载器 (基于 TikHub API)

用法:
  node src/cli.js <命令> [参数]

命令:
  user <标识>                         查询用户信息（抖音号 / uid / sec_user_id / 主页链接）
  download <标识> [选项]              下载指定用户的 作品/点赞/收藏（自动区分视频与图集）
  download --url <链接|aweme_id>      下载单个作品（分享链接或作品 id，支持视频与图集）
  watch                               启动轮询监听（自动下载 config.json 中 watchers 的新增视频）
  watch --once                        只执行一次监听检查后退出
  serve [--port 8787]                 启动 HTTP JSON API（供 Openclaw / 脚本调用）
  mcp                                 启动 MCP 服务器（stdio，供 Openclaw 的 mcpServers 接入）

download 选项:
  --type <post|like|collect>          下载类型，默认 post（作品）
  --limit <N>                         最多下载 N 个（默认全部）
  --cookie <str>                      抖音 Cookie（收藏列表必需）

标识说明:
  支持抖音号、sec_user_id(MS4wLjAB...)、纯数字 uid、主页链接、分享链接。
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') { args.flags.once = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args.flags[key] = val;
      continue;
    }
    args._.push(a);
  }
  return args;
}

async function cmdUser(args) {
  const id = args._[0];
  if (!id) { log.error('请提供用户标识，例如: node src/cli.js user 抖音号'); process.exit(1); }
  const info = await queryUser(id);
  console.log(JSON.stringify(info, null, 2));
}

async function cmdDownload(args) {
  if (args.flags.url) {
    const r = await downloadSingle(args.flags.url);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const id = args._[0];
  if (!id) { log.error('请提供用户标识或 --url'); process.exit(1); }
  const type = args.flags.type || 'post';
  const limit = args.flags.limit ? parseInt(args.flags.limit, 10) : Infinity;
  const cookie = args.flags.cookie || '';
  const stats = await downloadVideos({ identifier: id, type, limit, cookie });
  console.log(JSON.stringify(stats, null, 2));
}

async function cmdServe(args) {
  const { startServer } = await import('./server.js');
  const port = args.flags.port ? parseInt(args.flags.port, 10) : 8787;
  await startServer(port);
}

async function cmdMcp() {
  const { startMcpServer } = await import('./mcp.js');
  await startMcpServer();
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw.includes('-h') || raw.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }

  const [cmd, ...rest] = raw;
  const args = parseArgs(rest);

  // serve / mcp 允许在未配置 API Key 时先启动（供 Openclaw 注册），
  // 具体调用接口时 tikhubRequest 会给出清晰的报错。
  if (!config.apiKey && !['serve', 'mcp'].includes(cmd)) {
    log.error('未配置 TikHub API Key。请在 config.json 中设置 apiKey，或设置环境变量 TIKHUB_API_KEY。');
    process.exit(1);
  }

  try {
    switch (cmd) {
      case 'user': return await cmdUser(args);
      case 'download': return await cmdDownload(args);
      case 'watch': return await startPoller({ once: !!args.flags.once });
      case 'serve': return await cmdServe(args);
      case 'mcp': return await cmdMcp();
      case 'list':
        if (!args._[0]) { log.error('list 命令需要用户标识'); process.exit(1); }
        console.log(JSON.stringify(await listVideos({
          identifier: args._[0],
          type: args.flags.type || 'post',
          limit: args.flags.limit ? parseInt(args.flags.limit, 10) : 20,
          cookie: args.flags.cookie || '',
        }), null, 2));
        return;
      default:
        log.error(`未知命令: ${cmd}\n`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (e) {
    log.error(`执行失败: ${e.message}`);
    process.exit(1);
  }
}

main();
