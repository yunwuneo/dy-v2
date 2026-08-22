#!/usr/bin/env node
// MCP 服务器（stdio 传输）。stdout 只能输出 JSON-RPC，日志统一走 stderr。
process.env.LOG_TO_STDERR = '1';

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { log } from './logger.js';
import { queryUser, listVideos, downloadSingle, downloadVideos } from './tasks.js';

const TOOLS = [
  {
    name: 'query_user',
    description: '查询抖音用户信息。支持抖音号、纯数字 uid、sec_user_id(MS4wLjAB...) 或用户主页链接。',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: '抖音号、uid、sec_user_id 或主页链接' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'list_videos',
    description: '列出用户的作品/点赞/收藏内容元数据（不下载）。type: post=作品, like=点赞, collect=收藏。返回中 is_image_post 标识图集（图片帖），image_count 为图片数量。',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: '用户标识' },
        type: { type: 'string', enum: ['post', 'like', 'collect'], description: '默认 post' },
        limit: { type: 'number', description: '数量，默认 20' },
        cookie: { type: 'string', description: '抖音 Cookie（collect 收藏类型必需）' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'download_videos',
    description: '下载用户的作品/点赞/收藏内容，自动区分视频与图集：视频保存为 mp4，图集的全部图片保存到以作品命名的目录。按「用户/类型」分类归档。',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: '用户标识' },
        type: { type: 'string', enum: ['post', 'like', 'collect'], description: '默认 post' },
        limit: { type: 'number', description: '最多下载数量，缺省为全部' },
        cookie: { type: 'string', description: '抖音 Cookie（collect 收藏类型必需）' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'download_single',
    description: '下载单个作品。参数为分享链接或作品 aweme_id。自动识别视频（存为 mp4）与图集（全部图片存入目录）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '分享链接或 aweme_id' },
      },
      required: ['url'],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'query_user':
      return await queryUser(args.identifier);
    case 'list_videos':
      return await listVideos({
        identifier: args.identifier,
        type: args.type || 'post',
        limit: args.limit ?? 20,
        cookie: args.cookie || '',
      });
    case 'download_videos':
      return await downloadVideos({
        identifier: args.identifier,
        type: args.type || 'post',
        limit: args.limit ?? Infinity,
        cookie: args.cookie || '',
      });
    case 'download_single':
      return await downloadSingle(args.url);
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    const { id, method, params } = msg;

    // 通知消息（无 id）无需响应
    if (id === undefined || id === null) return;

    try {
      switch (method) {
        case 'initialize':
          write({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params?.protocolVersion || '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'douyin-downloader', version: '1.0.0' },
            },
          });
          break;
        case 'ping':
          write({ jsonrpc: '2.0', id, result: {} });
          break;
        case 'tools/list':
          write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
          break;
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments || {};
          const result = await callTool(name, args);
          write({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false },
          });
          break;
        }
        default:
          write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true },
      });
    }
  });

  log.error(`[MCP] douyin-downloader MCP 服务器已启动（stdio），已暴露 ${TOOLS.length} 个工具`);
}

// 直接以 `node src/mcp.js` 运行时自动启动（Openclaw 会以此方式拉起 stdio 服务器）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer();
}
