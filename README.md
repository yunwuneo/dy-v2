# 抖音视频下载器（基于 TikHub API）

一个基于 [TikHub](https://tikhub.io/) 抖音网页版 API 的 Node.js 视频下载器，支持：

- ✅ 下载指定用户的**作品 / 点赞 / 收藏**视频（可指定数量或全部）
- ✅ **图集（图片帖）支持**：自动识别，全部原图保存到以作品命名的独立目录（零额外 API 费用）
- ✅ **轮询监听**，自动下载监听目标的新增视频，并按「用户 / 类型」分类归档
- ✅ 优先下载**高清无水印**原画质视频（`fetch_video_high_quality_play_url`）；高清 CDN 不可用时尝试备用播放地址
- ✅ 与 **Openclaw** 交互：通过 MCP 服务器、HTTP JSON API 或 CLI 三种方式触发查询与下载
- ✅ 内置 **Web UI**：查询和下载作品，并在管理后台预览、筛选与删除本地内容
- ✅ **控制台与后台任务**：排队、并发下载、实时进度、取消、重试和任务历史
- ✅ **大媒体库**：后台线程建立索引，服务端搜索、筛选和分页

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
#    也支持项目根目录的 .env；优先级为系统环境变量 > .env > config.json

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
| `dataDir` | 下载记录、任务历史和媒体索引目录，默认 `./data` |
| `downloadConcurrency` | 每个批量任务同时下载的作品数，默认 `3`，范围 `1–8`；图集内图片顺序下载 |
| `taskConcurrency` | Web 后台同时执行的任务数，默认 `1`，范围 `1–8` |
| `libraryCacheSeconds` | 媒体索引缓存时间，默认 `30` 秒；手动刷新和任务完成会使缓存失效 |
| `count` | 每页数量（建议 ≤ 20） |
| `pollIntervalSeconds` | 每轮完成后等待的秒数，实际最小 5 秒；修改后重新计算下次时间 |
| `pollerEnabled` | Web 自动轮询启停状态，默认 `false`；Web UI 启停会保存，服务重启后恢复 |
| `cookie` | 全局抖音 Cookie（**收藏列表必需**） |
| `saveMetadata` | 是否随媒体保存元数据 JSON（默认 `true`） |
| `logDir` | 运行日志目录，默认 `./logs`（写入 `app.log`） |
| `errorDir` | 结构化错误报告目录，默认 `./errors`（每次接口/下载失败写入 JSON） |
| `watchers` | 轮询监听目标数组 |

### 监听目标（watcher）示例

```jsonc
{
  "watchers": [
    {
      "identifier": "抖音号或主页链接",
      "name": "可选显示名（默认用昵称）",
      "enabled": true,                        // 可单独暂停目标，省略时为 true
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

已有 `data/downloaded.json` 自动作为下载记录快照读取，新操作追加到 `downloaded.json.jsonl`。跨进程文件锁保护读写，每 2,000 次操作原子更新快照并压缩日志；不要只复制快照而遗漏日志。记录损坏会报错，避免静默丢失历史。轮询时会自动跳过已下载项，实现增量下载。

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

- **控制台**：任务数量、实时进度、取消/重试、最近 200 条运行日志与 API 请求次数。
- **下载**：用户信息查询、作品/点赞/收藏预览、批量下载及分享链接单项下载。提交后进入后台队列，关闭浏览器不会中断下载，Node 服务需保持运行。
- **已下载**：本地媒体统计、标题/作者/作品 ID 搜索、用户/分类/媒体筛选、视频播放、图集浏览、元数据查看和本地文件删除。
- **轮询监听**：启动/停止自动轮询、立即检查全部或单个目标；查看本轮目标及作品进度、最近开始/结束、下次检查、下载/跳过/失败数量。目标可新增、编辑、暂停、移除和更新昵称，检查记录进入下载任务历史。
- **设置**：修改连接、调度和存储参数；密钥与 Cookie 留空时保留原值，接口不会回传其明文。

Web 服务内置轮询调度：在“轮询监听”页面点击“启动监听”即开始检查，页面关闭后仍继续运行。每轮完成后等待 `pollIntervalSeconds` 再运行，轮次不会重叠；“停止监听”取消本轮由轮询提交的未完成任务，已完成文件保留，普通下载任务继续运行。“立即检查”只运行一次，停止状态下使用它不会启用自动轮询。运行历史保存在 `dataDir/poller-state.json`，服务重启后保留最近结果；之前已启用的监听恢复调度。

“API 成本账单”从启用后按 TikHub 端点累计实际发起的请求次数（包含重试）、成功和失败次数，并保存在 `dataDir/api-billing.json`。页面打开或手动刷新时查询 TikHub 账户余额和免费额度。金额是参考单价估算：普通抖音端点暂按 $0.001/次，高清播放链接端点按官方标价 $0.005/次；未定价端点显示“未计价”。估算只计成功响应，不含阶梯折扣、免费额度、后续价格变化或其他客户端的调用；实际扣费以 TikHub 账户账单为准。余额查询端点自身也记入请求数，但因未确认单价不计入估算。余额接口：`GET /api/billing/balance`；本地账单：`GET /api/billing`。

设置通过 Web UI 保存后立即热重载；直接修改 `config.json` 通常在 1 秒内检测并应用，格式或参数无效时保留上一份有效配置并提示错误。只有 `outputDir`（下载目录）和 `dataDir`（数据目录）需要重启，界面会列出待重启项，避免进行中的任务跨目录写入和数据锁失效。

| 设置 | 生效时机 |
| --- | --- |
| 监听启停、轮询间隔 | 立即生效，间隔变化重新计算下次检查时间 |
| 目标账号、内容类型、数量、专用 Cookie | 后续目标检查使用新设置；暂停/移除正在检查的目标取消其当前任务 |
| API Key、API 地址、区域、每页数量、重试、超时 | 后续请求使用新设置；已经发出的请求正常完成 |
| 全局 Cookie、下载并发 | 后续检查/任务使用新设置 |
| 任务并发 | 立即调整队列；减少时等待已运行的任务完成 |
| 媒体库缓存、日志目录、错误目录、元数据开关 | 无需重启，后续扫描/写入使用新设置 |
| 下载目录、数据目录 | 重启服务后生效；不自动移动已有文件 |

环境变量 `TIKHUB_API_KEY` 仍优先于配置文件，修改进程环境变量需要重启。用户资料查询获得的昵称会缓存到 `dataDir/user-names.json`，用于替代界面中的 `sec_user_id`；已有目标可点击“更新昵称”补充缓存。

管理后台只扫描 `outputDir`，媒体读取和删除操作均限制在该目录内。删除作品会同时清理配套元数据和去重记录，之后可以重新下载。

任务历史保存在 `dataDir/jobs.json`，最多保留 200 条。媒体下载按无数据时间判断超时；连接中断时保留 `.part` 文件，后续用 HTTP Range 续传，只有完整文件才会发布为 `.mp4`。取消会清理当前未完成文件，已下载文件保留。失败、部分完成和取消的任务可重试；无 Cookie 的作品/点赞批量任务在服务重启后仍可手动重试。服务重启时，未完成任务标记为“已中断”；普通下载任务不自动重试，已启用的轮询按保存状态恢复调度。Cookie 和查询原始数据仅在内存中保留，不写入任务历史。

也可使用独立的 `npm run watch`，该进程支持配置热重载，但需在启动终端启停，不进入 Web 任务历史。Web 轮询与独立 CLI 轮询共享监听锁，同一 `dataDir` 只允许一个监听进程，避免重复检查。同一 `dataDir` 也只允许一个 Web 服务；CLI 和 Web 可通过下载记录锁共享去重存储。

媒体扫描在工作线程中进行，索引保存在 `dataDir/library-index.json`；查询默认返回 24 条，最大 200 条，支持 `offset`、`limit`、`search`、`kind`、`user`、`type` 参数。`refresh=1` 重新扫描外部变动。图集没有 `metadata.json` 时也能被识别。列表只返回摘要，媒体详情按需读取。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/health` | GET | 健康检查 |
| `/api/user?identifier=xxx` | GET | 查询用户信息 |
| `/api/list?identifier=xxx&type=post&limit=20` | GET | 列出视频 |
| `/api/list` | POST | 列出视频 `{identifier,type,limit,cookie}`（适合传 Cookie） |
| `/api/lookup` | POST | 一次查询用户与列表并返回可复用的 `lookupId` |
| `/api/download` | POST | 批量下载 `{identifier,type,limit,cookie}` |
| `/api/download/single` | POST | 下载单个 `{url}` |
| `/api/jobs` | POST | 异步提交，返回 `202` 与任务 ID：批量 `{identifier,type,limit,cookie,lookupId}`；单项 `{kind:"single",url}` |
| `/api/jobs` | GET | 分页任务历史，支持 `offset`、`limit`、`status` |
| `/api/jobs/:id` | GET | 任务状态与进度 |
| `/api/jobs/:id/cancel` | POST | 取消等待中或运行中的任务 |
| `/api/jobs/:id/retry` | POST | 新建重试任务 |
| `/api/console` | GET | 控制台统计、监听目标和脱敏日志 |
| `/api/settings` | GET / PUT | 获取脱敏设置或保存并热重载；返回 `restartFields` 列出需要重启的目录项 |
| `/api/watchers` | PUT | 保存并热重载监控目标数组，支持 `id` 和 `enabled` |
| `/api/watchers/:index/run` | POST | 检查单个目标一次并返回轮询状态；正在检查时返回 409 |
| `/api/poller` | GET | 获取轮询状态、时间、本轮进度及各目标检查结果 |
| `/api/poller/start` | POST | 启用自动轮询并保存启用状态 |
| `/api/poller/stop` | POST | 停止轮询并取消其当前任务，保存停止状态 |
| `/api/poller/run` | POST | 立即检查全部启用目标一次 |
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

作品和点赞列表实际优先调用 `/api/v1/douyin/app/v3/fetch_user_post_videos`、`fetch_user_like_videos`，遇到可重试错误或接口不可用时降级到表中的 Web 接口。确定性的参数错误不会额外降级请求。

## 测试与调试

`npm test` 使用模拟上游、临时目录和本地 HTTP 服务，不消耗 TikHub 额度。覆盖下载并发、取消与重试、任务恢复、跨进程记录合并、媒体分页和 Range 读取。

真实验证需明确执行 `node scripts/live-smoke.mjs --confirm-paid`，或执行 `node scripts/protocol-smoke.mjs --confirm-paid` 验证 CLI/MCP。二者使用 `logs/live-budget.json` 中的累计请求记录，60 次为硬上限，按每次 $0.01 保守预留最多 $0.60；不会自动清零。实际价格以 TikHub 端点定价及账单为准。普通 `npm run serve` 不启用此测试额度限制，默认不启用监听；若此前通过 Web UI 保存了 `pollerEnabled: true`，会恢复轮询。

`node --import ./scripts/live-budget.mjs src/cli.js serve` 可为浏览器调试启用相同的请求上限。真实测试结果写入 `logs/live-results.json`，不包含 API Key。由于收藏需要账号 Cookie，未配置 Cookie 时仅验证其参数检查，不发起真实收藏请求。

## 注意事项

- **收藏列表**需要用户自己的抖音网页 Cookie（`config.json` 的 `cookie` 或 watcher 的 `cookie`），因为收藏属于私密数据。
- TikHub 接口按次计费，轮询会持续消耗额度，请合理设置 `pollIntervalSeconds` 与 `limit`。
- 下载与 watcher 使用增量分页：当前页出现本地已下载作品后停止继续翻页，但仍处理完整的边界页。
- 抖音 Web 接口可能偶发不稳定，若作品列表为空请重试或改用 App 接口。
- 下载的视频请勿用于商业盗用，责任自负。

## License

MIT
