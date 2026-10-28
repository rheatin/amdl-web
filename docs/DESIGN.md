# 设计说明

本文件记录本项目的关键设计决策与若干「构建能过、运行才炸」的坑，便于后续维护与二次开发。
（不包含任何部署环境的私有信息。）

## 1. 分层与边界

```
浏览器 ── HTTP/SSE ──► amdl-web（Web 前端）
                          │  spawn 子进程
                          ▼
                    apple-music-dl（ripper：目录 / m3u8 / 分片下载 / 调用 Temari 解密）
                          │  HTTP
                          ▼
                    wrapper-lite（解密后端：账号会话 + /m3u8 /key /lyrics /license）
```

- **只起两个服务**：`wrapper-lite` 是唯一的「后端服务」，`amdl-web` 是前端 + ripper。
- **前端不做解密**：只负责账号、链接解析、任务队列、进度与音乐库。
- **ripper 与前端同容器**：因此 **不需要挂载 `docker.sock`**，前端容器也**不需要特权**。

## 1.1 界面结构：单屏工作台

界面只有**一个**主页面（`GET /`，`views/workbench.ejs`），结构与 AETHER AUDIO 那类
下载工作台一致：

```
┌ 顶栏：品牌 · 导航 · 遥测胶囊（队列 / 商店）────────────┐
├ Hero：一个输入框同时接受 Apple 链接与歌名/艺人/专辑 ────┤
│        下方一行：商店 · 歌词覆盖 · 自动匹配（含风险说明）  │
├ 左 8 列：队列（页签筛选 + 每行一条进度条 + 行内操作）────┤
└ 右 4 列：检视器（常驻吸顶，讲选中那条：规格四宫格 + 引擎输出）
```

**为什么从"五个页面"合成一个**：早先是 概览/搜索/任务/音乐库/配置，
而下载的完整流程（输入 → 找歌 → 排队 → 看进度 → 看详情）要在这几页之间来回跳。
合成单屏后，导航只剩三项（下载 / 音乐库 / 配置）——
`/search` 与 `/jobs` 仍可直达（书签、深链），但不再作为导航项：
导航里摆三个指向同一件事的入口，只会让人以为它们是三件事。

**"加入队列"同时接受链接与关键词**：判断"这是链接还是关键词"不需要额外的 UI 开关
（模板也是这么做的）。是链接就直接建任务；是关键词就跳搜索，搜索结果里每条自带
可用编码，所以不需要"先解析再选编码"那个中间步骤。

**选中走 URL（`?job=<id>`）而不是内存状态**：刷新页面、复制链接到另一个标签页，
收到的都是同一个任务；代价是每次切换发一次请求，而这正好拿到了检视器需要的服务端内容。

## 1.2 进度从哪来

引擎**没有进度接口**，汇总行（`Completed: 11/12`）只在**全部跑完之后**打印一次。
在那之前界面能显示的只有"进行中"三个字。

所以 `web/src/progress.ts` 从引擎的实时输出里解析进度，识别这几种行
（格式取自真实任务日志，单测的 fixture 就是那些日志）：

```
Track 7 of 12: songs                          ← 第几首 / 共几首
04 晴天                                        ← 曲目标题
24-bit / 96000 Hz                             ← 该曲规格
Decrypting...  62%  (18.2/34 MB, 2.9 MB/s)   ← 曲内进度 + 体积/速度
Decrypting... 100%  (34/34 MB, 2.9 MB/s) [10s]
Decrypted                                      ← 该曲完成
=======  [✔ ] Completed: 12/12 | Warnings: 0 | Errors: 0 =======
```

三个必须记下来的坑：

1. **行里有 `\r`**：引擎用回车原地刷新进度条，一行里串着多次刷新。
   直接去掉 `\r` 会把它们首尾相连，于是第一个匹配胜出、进度永远停在 0%。
   正确做法是按 `\r` 切片**只取最后一段**。
2. **`Decrypted` 不是可靠的完成信号**：实测**成功**的 12 首任务日志里一条都没有
   （引擎只在部分代码路径上打它）。只靠数它，进度条永远停在 91%。
   终点信号必须用收尾汇总行。
3. **失败的任务不该显示满条**：`Errors>0` 时按实际完成数显示，
   否则一个"11/12、1 首失败"的任务会显示满条，用户检查时会发现少了一首 —— 界面在骗人。

进度经 SSE 的 `progress` 事件实时广播（节流：读数变化且间隔 ≥200ms 才发），
前端**只改那一行的宽度与数字，不重新拉列表** —— 重新拉会换掉整块 DOM，
正在 hover 的行会闪、滚动位置会跳、选中高亮会丢。

已结束的任务没有实时事件，所以 `/api/jobs` 用 `job.log` 回填一次
（`progressFromLog`），于是"刚刷新页面进度条就空了"不存在。

## 2. 关键机制

### 2.1 按任务覆盖引擎配置

引擎用 `os.ReadFile("config.yaml")` 从**进程工作目录**读配置。因此每个任务：

1. 读取基础配置（`config.yaml`，不存在则回落到 `config.example.yaml`）；
2. 按任务选项逐行覆盖若干键（`embed-lrc` / `save-lrc-file` / `lrc-type` / `lrc-extra` / `lrc-format` / `lite-server`）；
3. 写入 `<DATA_DIR>/jobcfg/<jobId>/config.yaml`，**以该目录为 cwd** 启动引擎。

覆盖方式刻意保持朴素（按 `^key:` 替换字符串，不引入 YAML 依赖），保证未知键不丢失。

### 2.2 编码能力来自 Apple，而不是硬编码

`GET /api/codecs?url=` 会解析链接（单曲 / 专辑 / 播放列表），再查 Apple 目录 API 的
`attributes.audioTraits`：

| trait | 界面选项 |
|---|---|
| `lossless` / `hi-res-lossless` | ALAC 无损 |
| `atmos` / `spatial` | Dolby Atmos |
| （始终） | AAC 有损 |

专辑 / 播放列表取**所有曲目 traits 的合集**。目录 API 是分店铺的（`/cn/` 的曲目查 `/us/` 会 404），
因此优先使用链接自带的地区。

### 2.3 开发者 token 的获取与容错

Apple 网页播放器的开发者 token（JWT）内嵌在 `music.apple.com` 的 JS bundle 中。实现细节：

- 请求 `music.apple.com` **必须跟随 302**（Node 的 `fetch` 默认跟随）；
- bundle 里通常有**多个** JWT，且**并非都可用**（实测其中一个返回 401）；
- 因此不信任任何单个候选：把候选列表按「WebPlayKid 优先」排序后**逐个尝试**，
  遇 401/403 自动换下一个，命中后缓存。

### 2.4 下载后统一文件权限

引擎流式写入时用的是 `0600`，媒体服务器（jellyfin / navidrome）常以别的 uid 运行会读不到。
任务成功后按 `FILE_MODE`（默认 `666`）调整音频文件与同目录的封面 / 歌词文件。

### 2.5 SSE 与「状态回填」

任务页用 SSE 推送 `hello` / `log` / `status`。**页面可能在任务运行中渲染，而终态事件在
SSE 连接建立之前就已发出** —— 若 `hello` 只回放日志而不同步状态，徽章会永远停在运行中。
因此 `hello` 必须用其中的任务状态对齐界面（列表徽章同理）。
终态有三个（`done` / `partial` / `failed`）—— 客户端收尾判断必须三个都算，漏掉 `partial`
会导致「部分完成」的任务控制台永不收尾。

### 2.6 任务级「元数据地区」覆盖

**为什么是改 URL 而不是加配置键**：引擎的地区**只从 URL 取**
（`storefront, id := checkUrl(urlRaw, …)`），`config.yaml` 里的 `storefront` 只影响引擎自己的
搜索命令。所以「这一单用日区元数据」只能落成**改写链接的地区段**（`region.ts` + `urlinfo.swapRegion`）。

**探测三态**（沿用 amp-api 的既有约定：404 → `null`，其它异常 → 抛错）：
目标区有 → 用改写后的 URL；404 → 回退到原链接；抛错 → 也回退。第二与第三种**必须分开提示**，
否则一次网络抖动会被说成「日区没上架」——而这会直接改变用户对「要不要换记录」的判断。

**通知提前到决策点**：`GET /api/codecs` 与建任务共用同一个 `resolveRegionPlan()`，
于是「会不会回退」在**点下载之前**就显示出来；建任务后原因随任务一起存下来，任务页与列表可见。

**确定性**：任务记录里存**实际执行**的 URL 与整份地区计划，重试直接克隆、**不再探测** ——
目录会随时间变化，重试不该漂到别的地区或别的记录。

**自动匹配（默认关）**：目标区没有时，先按「艺人 + 完整曲名」搜，搜不到再放宽到「艺人 + 首词」
「仅艺人」（实测完整罗马音标题在日区**零结果**，缩短才能命中），候选**必须**通过
「艺人名一致（去空白、忽略大小写）+ 时长 ±1s」才采用；否则一律回退。
理由是同名不同版本（翻唱/现场/TV size）在搜索结果里就可能混进来 —— 实测撞见过 1 分 01 秒的同名翻唱，
而标题因语言不同不可直接比较，因此宁可回退也不猜。整张专辑/播放列表不做替换（会改变任务规模）。

**已验证的坑**：目录查询的 `language` 会覆盖标题语言（日区 + `l=en-US` → 英文/罗马音标题），
所以「地区对了但标题还是罗马音」时先查 `language`，不要怀疑地区没生效。

## 3. 构建期自检（把「运行才暴露」的错误提前）

`Dockerfile.web` 在构建阶段就验证三件事，失败即中断构建：

1. **引擎二进制能否 `execve`**：在 musl 基础镜像（alpine）里编译、却放进 glibc 运行时（Debian）
   会产生带 `PT_INTERP` 的二进制，运行时 `execve` 直接失败，而 Node 的 `spawn` 只报
   `ENOENT` —— 极难从现象看出原因。故编译器统一用 glibc 镜像，并做 `ldd` 检查。
2. **Temari 自带 cdylib 是否可解析**：Temari 的 Go 绑定用 `runtime.Caller(0)` 定位
   `<module>/lib/<platform>/libtemari.so`，而那是**编译期的模块缓存路径**；精简运行时里不存在。
   因此构建时用 `go list -m -f '{{.Dir}}'` 取模块目录，并把 `lib/` 还原到**同一路径**。
3. **系统 CA 证书是否存在**：Go 用系统 CA 库，而 `node:*-slim` 不带 `ca-certificates`；
   Node 自带 CA，所以现象是「前端 fetch 正常、引擎报 `x509: certificate signed by unknown authority`」。

## 4. 环境相关的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `git clone` 失败但 `curl` 正常 | 部分网络环境下 git 的 TLS 被重置 | 用 `codeload` 拉 tarball（见 README） |
| CMake `FetchContent` 拉不到依赖 | 其内部走 `git clone` | 依赖 vendor 到 `deps/` + `-DFETCHCONTENT_SOURCE_DIR_*` |
| 改了挂载的 `config.yaml` 但容器里没变 | ① `sed -i` / `rename` 会换 inode，而 bind mount 锁定启动时的 inode；② 单文件 bind mount 不跟随路径替换 | 原地覆盖（`fs.writeFileSync` 同一路径），**不要** `sed -i`。网页写回走的就是这条路，因此无需重启 |
| 网页写配置报 `EROFS` / `EACCES` | compose 里该文件挂载带 `:ro` | 去掉 `:ro`；容器用户（`user:`）需对该文件有写权限 |
| 备份文件建不出来（`.bak` 报 `EACCES`） | `/engine` 目录属于 root，只把单文件挂了进去 | 备份写到 `/data`（可写卷），见 `writeEngineConfigTo` |
| 浏览器放不了库里的 `.m4a` | 引擎落盘的是 **ALAC**；实测 Chrome `MSE audio/mp4; codecs="alac"` → false（Firefox 同样不支持，只有 Safari 系可以） | 播放时转成 **FLAC**（同为无损，仅换熵编码，实测 5 分钟曲目 1.1 秒），缓存到 `data/web/playcache/`。见 `src/playcache.ts` |
| 播放条把进度条挤成一条线 | 全局有 `input:not([type="radio"]) { width: 100% }`（权重 0,1,1），单个类名（0,1,0）压不住 | 音量条写成 `.player .player-volume`（0,2,0），进度条显式 `width: auto` |
| 网页提交 2FA 写不进 `data/wrapper/` | 上游 entrypoint 会 `chown -R root:root` 该目录 | 预置 `2fa.txt` 并 `chmod 666`（`chown` 不改模式位） |
| rootless 启动器起不来 | 它需要在容器内挂载 procfs，部分内核不允许（`cap_add: SYS_ADMIN` 亦无效） | 使用 `privileged: true`（与上游 README 一致），或改用上游的 `wrapper-lite-qemu` |

## 5. 前端设计系统

视觉基调取自 AETHER AUDIO：深空底 + 蓝图网格 + 青/紫霓虹 + 玻璃面板。
零依赖、单文件 `public/app.css`，无构建步骤。

### 5.1 三套标度

早先版本有 17 种字号（10→24px）、五种 gap、一屏内五种间距，是"看起来没收敛"的根源。
现在收敛成三族，用前缀命名，用错前缀在 review 时一眼可见：

| 族 | 前缀 | 说明 |
|---|---|---|
| 间距 | `--space-N` | 4px 基数；只允许这些值 |
| 字号 | `--text-N` | 比例约 1.125，下限 11px |
| 动效 | `--dur-*` / `--ease-*` | 四档时长 + 两条缓动 |

### 5.2 抬升层级

早先除 `.card` 外没有任何阴影，`.opts` / `.quality` / `.list li` 只靠色差和 1px 细线分隔，
在深色底上全挤在一个平面。现在三层固定映射：

`--shadow-1`（行内元素）→ `--shadow-2`（卡片）→ `--shadow-3`（浮层/toast），
外加 `--shadow-glow`（霓虹辉光，仅主按钮与强调元素）与 `--inner-hairline`（玻璃内侧高光）。

**表面色阶必须单调递进**（越深越亮）。旧版本正好相反：`.quality-list li` 用比容器
`--bg-soft` 更亮的 `--surface`，于是嵌套项浮在容器之上 —— 任何有层次感的系统都会避免这点。

### 5.3 音乐库的封面从磁盘拿

引擎下载时会把封面写成**音频同目录的 `cover.jpg`**（`filemode.ts` 的 `SIDECAR`
集合里本来就有 jpg）。所以音乐库的封面不需要任何网络请求，也**不需要回填历史任务**：
只要曲目在磁盘上，封面就在它旁边。实测 102 个历史任务、258 首里有 251 首能这样拿到封面。

`store.allTracks()` 按优先级取：曲目自带 → 磁盘同目录 `cover.jpg` → `job.meta.artwork`
（新任务建单时探到的 mzstatic 原图，分辨率更高，作兜底）。

**`GET /api/cover` 只暴露封面本身**，不 `express.static(MUSIC_DIR)`：
后者等于把整个音乐目录（含几十上百 MB 的音频）变成 HTTP 可读，而这个站点很可能挂在反代后面。
三重限制，缺一不可：

1. 必须登录
2. 路径必须解析到某个已知落盘目录之下（真子路径判定，防 `../` 穿越）
3. 文件名固定 `cover.jpg`，不接受调用方指定别的文件

`test/cover.test.mjs` 守住这三条 —— 它已经抓到一个真实 bug：路由最初注册在
`app.use(attachUser)` **之前**，于是 `res.locals.user` 永远不存在，`requireAuth` 一律 401
（表现为"封面全部裂开"，而日志里什么都没有）。

### 5.4 信息分层：常驻 vs 展开

搜索结果与任务卡遵循同一条规则：**常驻只留能决定"下什么"的东西**
（封面 / 标题 / 艺人 / 可下载的编码芯片），时长、年份、完整规格、地区风险、下载动作
全部收进展开层 —— hover 浮起，点击打 `.open` 常驻（触屏没有 hover）。

解释性文字（地区语义、自动匹配风险、歌词覆盖）用 `.why` 问号气泡承载，hover 或聚焦展开。

### 5.5 引擎上限必须与 Apple 能力一起显示

界面上的 Hi-Res 判定来自 master playlist（位深 ≥24 且采样率 >48 kHz），
而**落盘的是引擎 `media.alac-max` 允许的那一档**。两者不是一回事：
`alac-max: 48000` 时界面照样标「24-bit/96 kHz · 超出引擎上限」。

所以 `qualityCeilingsFromConfig()` 读出上限 → `/api/codecs` 返回 `ceilings` →
封面卡给超限的芯片加 `.capped` 类并在展开层写明原因；配置页「音质与画质上限」栏同源展示。
**界面报的是 Apple 的能力，落盘的是引擎的上限，两件事都要说。**

### 5.6 封面模板的形状不固定（实测四种）

mzstatic 的封面 URL 是带占位符的模板，实测见过四种形状：

```
…/xxx.rgb.jpg/{w}x{h}{f}      →  300x300bb.jpg
…/JAY.jpg/{w}x{h}bb.jpg       →  300x300bb.jpg      （位深已写死在模板里）
…/xxx.jpg/{w}x{h}.jpg         →  300x300bb.jpg
…/xxx.jpg/{w}x{h}             →  300x300bb.jpg
```

只认第一种会拼出 `…/{w}x{h}bb.jpg/300x300bb.jpg` 这种垃圾串 → 浏览器 404，
而 **`<img>` 加载失败不产生任何控制台错误**，界面上只是"封面偶尔不显示"，极难归因。
位深段一律固定成 `bb`（实测 `600x600dd.jpg` 是 404）。

规则实现在 `index.ts` 的 `art()`，通过 `app.locals.art` 注入所有视图；
`test/result-card.test.mjs` 逐字比对视图渲染出的 `<img src>` 与 `ampmusic.artworkAt`。

### 5.7 为什么 art() 由服务端注入而不是 EJS partial

EJS 把每个模板编译成**独立函数**，`const` 声明不会带回调用方
（实测连往 `locals` 上赋值也带不回来，include 只单向向下可见）。
所以"抽一个 partial 出来 include"在 EJS 里根本做不到，而本项目又刻意不引入
构建步骤把视图与 TS 拼在一起。于是规则只存在于 TS 一处，视图通过局部量拿到它。

### 5.8 CSS 注释里不能出现注释结束符

注释里写 `--dur-*/--ease-*` 这样的通配，会因为内含注释结束符而**提前闭合**，
其后的内容（包括整个 `:root` 令牌块）被浏览器当成非法 CSS 静默丢弃：
页面不报错，只是所有颜色/圆角/间距失效，退化成无样式的裸 HTML。
从截图上要等很久才看得出来。`test/result-card.test.mjs` 里有这条断言。


## 6. 数据与状态

- 前端状态：`data/web/amdl-web.json`（账号、任务、结果）+ `session.secret`（会话签名密钥），均为原子写。
- 每个任务的引擎配置：`data/web/jobcfg/<id>/config.yaml`。
- wrapper 的账号会话与 token 缓存：`data/wrapper/`（**含解密所需凭据，注意保护**）。
- 下载落盘：由 `.env` 的 `MUSIC_DIR` 决定，容器内固定为 `/downloads`。
