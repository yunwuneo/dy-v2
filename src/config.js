import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULTS = {
  baseUrl: 'https://api.tikhub.io',
  region: 'CN',               // 请求出口地区，CN 走国内 CDN 下载更快
  outputDir: './downloads',   // 视频保存目录
  count: 20,                  // 每页数量（建议 ≤ 20）
  downloadConcurrency: 3,     // 并发下载数（预留）
  pollIntervalSeconds: 300,   // 轮询间隔（秒）
  retry: 3,                   // 请求重试次数
  timeoutMs: 60000,           // 单次请求超时（毫秒）
  logDir: './logs',            // 运行日志目录
  errorDir: './errors',        // 结构化错误报告目录
  cookie: '',                 // 全局抖音 Cookie（收藏列表必须）
  watchers: [],               // 轮询监听目标
};

function loadConfig() {
  const configPath = process.env.DOUYIN_CONFIG || path.join(ROOT_DIR, 'config.json');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      throw new Error(`配置文件解析失败 ${configPath}: ${e.message}`);
    }
  }

  const apiKey = process.env.TIKHUB_API_KEY || userConfig.apiKey || '';
  const merged = { ...DEFAULTS, ...userConfig, apiKey };
  merged.outputDir = path.resolve(ROOT_DIR, merged.outputDir || DEFAULTS.outputDir);
  merged.logDir = path.resolve(ROOT_DIR, merged.logDir || DEFAULTS.logDir);
  merged.errorDir = path.resolve(ROOT_DIR, merged.errorDir || DEFAULTS.errorDir);
  return merged;
}

export const config = loadConfig();
