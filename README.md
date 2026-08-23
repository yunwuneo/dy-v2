# 抖音视频下载器（基于 TikHub API）

一个基于 [TikHub](https://tikhub.io/) 抖音网页版 API 的 Node.js 视频下载器，支持：

- ✅ 下载指定用户的**作品 / 点赞 / 收藏**视频（可指定数量或全部）
- ✅ **图集（图片帖）支持**：自动识别，全部原图保存到以作品命名的独立目录（零额外 API 费用）
- ✅ **轮询监听**，自动下载监听目标的新增视频，并按「用户 / 类型」分类归档
- ✅ 下载**高清无水印**原画质视频（`fetch_video_high_quality_play_url`）
- ✅ 与 **Openclaw** 交互：通过 MCP 服务器、HTTP JSON API 或 CLI 三种方式触发查询与下载
- ✅ 内置 **Web UI**：查询和下载作品，并在管理后台预览、筛选与删除本地内容

> 本项目仅用于个人学习与合法用途，请遵守抖音平台用户协议及相关法律法规，勿用于侵权或商业盗用。

---

## 环境要求

- Node.js ≥ 18（本项目使用原生 `fetch`，**零运行时依赖**）
- 一个 [TikHub](https://user.tikhub.io/) 账号与 API Key

## 快速开始

```bash
# 1. 初始化配置
cp config.example.json config.json
#    编辑 config.json，填入 apiKey（或在环境变量 TIKHUB_API_KEY 中设置）

# 2. 查询用户信息（验证 API 是否可用）
node src/cli.js user <抖音号>

# 3. 下载某用户的全部作品
node src/cli.js download <抖音号> --type post

# 4. 下载点赞 / 收藏
node src/cli.js download <抖音号> --type like
node src/cli.js download <抖音号> --type collect --cookie "你的抖音Cookie"

# 5. 下载单个视频（分享链接或 aweme_id）
node src/cli.js download --url "https://v.douyin.com/xxxx/"

# 6. 启动 Web UI
npm run serve
# 浏览器访问 http://127.0.0.1:8787
```

## 配置说明（`config.json`）

| 字段 | 说明 |
| --- | --- |
| `apiKey` | TikHub API Key（也可用环境变量 `TIKHUB_API_KEY` 覆盖） |
| `baseUrl` | `https://api.tikhub.io`（大陆用户可改为 `https://api.tikhub.dev`） |
| `region` | 下载出口地区，`CN` 走国内 CDN 更快 |
| `outputDir` | 视频保存根目录，默认 `./downloads` |
| `count` | 每页数量（建议 ≤ 20） |
| `pollIntervalSeconds` | 轮询间隔（秒） |
| `cookie` | 全局抖音 Cookie（**收藏列表必需**） |
| `saveMetadata` | 是否随媒体保存元数据 JSON（默认 `true`） |
| `watchers` | 轮询监听目标数组 |

### 监听目标（watcher）示例

```jsonc
{
  "watchers": [
    {
      "identifier": "抖音号或主页链接",
      "name": "可选显示名（默认用昵称）",
      "types": ["post", "like", "collect"],   // 要下载的类型
      "limit": 20,                            // 每次轮询最多检查的数量
      "cookie": ""                            // 收藏类型需填抖音 Cookie
    }
  ]
}
```

## 命令行用法

```
node src/cli.js <命令> [参数]

user <标识>                         查询用户信息
download <标识> [--type post|like|collect] [--limit N] [--cookie ...]
download --url <链接|aweme_id>      下载单个视频
list <标识> [--type ...] [--limit N] 列出视频元数据（不下载）
watch [--once]                      启动轮询监听（--once 只跑一次）
serve [--port 8787]                 启动 Web UI 与 HTTP JSON API
mcp                                 启动 MCP 服务器（stdio）
```

用户标识支持：抖音号、纯数字 `uid`、`sec_user_id`（`MS4wLjAB...`）、用户主页链接、分享链接。

## 目录结构（下载归档）

```
downloads/
├── 某用户昵称/
│   ├── 作品/
│   │   ├── 视频标题_awemeId.mp4        ← 普通视频
│   │   ├── 视频标题_awemeId.json       ← 视频元数据（与 .mp4 同名）
│   │   └── 图集标题_awemeId/           ← 图集（图片帖）
│   │       ├── img_01.jpeg
│   │       ├── img_02.jpeg
│   │       └── metadata.json           ← 图集元数据（目录内）
│   ├── 点赞/
│   └── 收藏/
└── ...
```

元数据 JSON 包含作品描述、创建时间、时长、作者信息、点赞/评论/分享/收藏数、BGM 等，并附 `local` 字段记录本地落盘路径与大小，便于后续管理。已下载但缺元数据的存量作品会在轮询/下载时自动补写。可用 `"saveMetadata": false` 关闭该功能。

已下载记录保存在 `data/downloaded.json`，轮询时会自动跳过，实现增量下载。

---

## 与 Openclaw 集成

Openclaw 是运行在本地、通过聊天应用驱动的开源 AI 助手，支持接入 MCP 服务器扩展工具。本项目提供三种接入方式：

### 方式一：MCP 服务器（推荐，stdio）

在 Openclaw 配置中注册本项目的 MCP 服务器：

```bash
# CLI 方式
openclaw mcp add douyin \
  --command node \
  --arg /Users/neo/repos/dy/src/mcp.js

# 验证是否可用
openclaw mcp doctor douyin --probe
```

或直接编辑 `~/.openclaw/openclaw.json`：

```jsonc
{
  "mcp": {
    "servers": {
      "douyin": {
        "command": "node",
        "args": ["/Users/neo/repos/dy/src/mcp.js"],
        "transport": "stdio",
        "enabled": true
      }
    }
  }
}
```

接入后，Openclaw 可获得 4 个工具：

| 工具 | 功能 |
| --- | --- |
| `query_user` | 查询抖音用户信息 |
| `list_videos` | 列出作品/点赞/收藏视频（不下载） |
| `download_videos` | 下载作品/点赞/收藏视频到分类目录 |
| `download_single` | 下载单个视频（分享链接/作品 id） |

之后即可在 Openclaw 聊天中自然地下达指令，例如：
> “帮我下载抖音号 xxx 的最新 10 个作品”
> “查一下 xxx 这个抖音号的基本信息”

### 方式二：HTTP JSON API

启动服务后，可通过 HTTP 触发（供 Openclaw 的 HTTP 工具或任意脚本调用）：

```bash
node src/cli.js serve --port 8787
```

服务启动后，直接访问 `http://127.0.0.1:8787` 即可使用 Web UI：

- **下载**：用户信息查询、作品/点赞/收藏预览、批量下载及分享链接单项下载。
- **已下载**：本地媒体统计、标题/作者/作品 ID 搜索、用户/分类/媒体筛选、视频播放、图集浏览、元数据查看和本地文件删除。

管理后台只扫描 `outputDir`，媒体读取和删除操作均限制在该目录内。删除作品会同时清理配套元数据和去重记录，之后可以重新下载。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/health` | GET | 健康检查 |
| `/api/user?identifier=xxx` | GET | 查询用户信息 |
| `/api/list?identifier=xxx&type=post&limit=20` | GET | 列出视频 |
| `/api/list` | POST | 列出视频 `{identifier,type,limit,cookie}`（适合传 Cookie） |
| `/api/lookup` | POST | 一次查询用户与列表并返回可复用的 `lookupId` |
| `/api/download` | POST | 批量下载 `{identifier,type,limit,cookie}` |
| `/api/download/single` | POST | 下载单个 `{url}` |
| `/api/library` | GET | 获取本地媒体库列表与统计 |
| `/api/library/item?id=...` | GET | 获取单条本地媒体详情 |
| `/api/library/media?id=...&file=0` | GET | 读取本地视频或图集图片（支持 Range） |
| `/api/library/item?id=...` | DELETE | 删除本地媒体、元数据与去重记录 |

```bash
curl "http://127.0.0.1:8787/api/user?identifier=抖音号"
curl -X POST "http://127.0.0.1:8787/api/download" \
  -H "Content-Type: application/json" \
  -d '{"identifier":"抖音号","type":"post","limit":10}'
```

### 方式三：CLI 命令

Openclaw 也可通过其 shell/exec 能力直接调用 CLI，例如：

```bash
node /Users/neo/repos/dy/src/cli.js download <抖音号> --type post --limit 10
```

---

## 关键接口说明

本项目基于 TikHub OpenAPI **V5.3.2** 的 `Douyin-Web-API` 分类，核心接口：

| 功能 | 接口 |
| --- | --- |
| 用户信息 | `GET /api/v1/douyin/web/handler_user_profile_v2?unique_id=` |
| 作品列表 | `GET /api/v1/douyin/web/fetch_user_post_videos?sec_user_id=` |
| 点赞列表 | `POST /api/v1/douyin/web/fetch_user_like_videos` |
| 收藏列表 | `POST /api/v1/douyin/web/fetch_user_collection_videos`（需 Cookie） |
| 高清无水印地址 | `GET /api/v1/douyin/web/fetch_video_high_quality_play_url?aweme_id=&region=CN` |

## 注意事项

- **收藏列表**需要用户自己的抖音网页 Cookie（`config.json` 的 `cookie` 或 watcher 的 `cookie`），因为收藏属于私密数据。
- TikHub 接口按次计费，轮询会持续消耗额度，请合理设置 `pollIntervalSeconds` 与 `limit`。
- 下载与 watcher 使用增量分页：当前页出现本地已下载作品后停止继续翻页，但仍处理完整的边界页。
- 抖音 Web 接口可能偶发不稳定，若作品列表为空请重试或改用 App 接口。
- 下载的视频请勿用于商业盗用，责任自负。

## License

MIT
