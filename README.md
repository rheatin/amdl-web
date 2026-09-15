# amdl-web

自托管的 Apple Music 下载站点：**浏览器里登录 → 粘贴链接 → 下载无损音乐**，以 Docker 部署。

本仓库提供 Web 界面与 Docker 编排；解密与下载复用下面「致谢」中列出的开源组件。

[English README →](README.en.md)

---

## ✨ 特性

- **Web 登录 → 填链接 → 下载**：无需命令行；任务有实时日志（SSE）、进度与结果记录。
- **编码按曲目真实能力生成**：解析链接后查询 Apple 目录 API 的 `audioTraits`，只列出该曲目
  真正支持的无损 / Dolby Atmos / AAC（专辑与播放列表取全部曲目的能力合集），而不是写死的选项。
- **不需要 Widevine CDM**：走 FairPlay 路线，只需一个 `wrapper-lite` 服务。
- **不挂 `docker.sock`**，前端容器**非特权**：ripper 与前端同容器，通过子进程调用。
- **歌词默认开启**：写进音频标签，并另存一份 `.lrc`；逐行或逐字 / 翻译或罗马音 / `lrc` 或 `ttml` 可按任务临时改。
- **失败一首不算白下**：引擎只有在全部成功时才打印落盘清单，所以任务失败时前端会按 mtime
  把这次真正写出的文件找回来 —— 状态记为 `partial`（部分完成）、权限照样统一、并给一个重试按钮。
- **下载后统一文件权限**（默认 `666`），便于以其它 uid 运行的媒体服务器读取。
- **元数据地区可按任务覆盖**：选「日本 jp」即把链接改写成日区，文件名与标签拿到日文原名；
  目标区没有这条记录时**自动回退**并在预览里说明；可选「自动找等价记录」（要求艺人+时长一致，有下错风险）。
- **网页内提交 Apple 2FA 验证码**，无需登录 NAS 改文件。
- 前端轻量：Express + EJS + 单个 CSS 文件，无前端框架依赖。

## 🏗 架构

```
浏览器（登录 / 解析链接 / 任务实时日志 / 音乐库）
   │ HTTP + SSE
   ▼
amdl-web 容器 ── 前端（Node + Express + EJS）
   │  spawn 子进程（每个任务一份私有 config.yaml）
   ▼
apple-music-dl ── ripper（Go；内含 Temari 完成 FairPlay 解密）
   │ HTTP :12340
   ▼
wrapper-lite ── 解密后端（Apple Music 账号会话 + /m3u8 /key /lyrics /license）
   │
   ▼
音乐目录（ALAC / Atmos / AAC）
```

仍然只起两个服务：`wrapper-lite`（唯一的「后端服务」）与 `amdl-web`（前端 + ripper）。
更多设计细节见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 📁 目录结构

```
.
├── docker-compose.yml        # 部署栈（wrapper-lite + amdl-web）
├── Dockerfile.web            # 合并镜像：Go 编译 ripper + Node 构建前端 + slim 运行时
├── Dockerfile.amdl           # wrapper-lite 的构建补丁（见「构建相关改动」）
├── .env.example              # 配置与私密信息集中在此（复制为 .env）
├── config.example.yaml       # 引擎配置模板（exit-on-error / 落盘目录 / 歌词项）
├── web/                      # 前端源码
│   ├── src/                  #   Express 服务、认证、Apple 目录客户端、ripper 适配器、队列
│   ├── views/                #   EJS 模板
│   ├── public/               #   样式与前端脚本（零框架）
│   └── test/                 #   单元测试（引擎输出解析 / 链接解析）
├── smoke-wrapper.sh          # 无凭据冒烟测试（验证启动链路与 /status）
├── verify-stack.sh           # 部署验证脚本
└── docs/DESIGN.md            # 设计说明与「构建能过、运行才炸」的坑
```

## 🚀 快速开始

前置：Docker + Compose v2，`linux/amd64` 环境。

```bash
git clone <this repo> amdl-web && cd amdl-web
cp .env.example .env                 # 填 Apple 账号、音乐目录等
cp config.example.yaml config.yaml   # 可选：调整引擎默认行为

# 1) 获取上游源码（git 不可用时见下方「上游源码获取」）
git clone -b lite https://github.com/WorldObservationLog/wrapper.git wrapper-lite
git clone https://github.com/zhaarey/apple-music-downloader.git engine

# 2) 构建（wrapper-lite 需交叉编译 Android 目标，耗时较长）
docker compose build

# 3) 冒烟测试：验证解密后端能启动（无需 Apple 凭据）
sh smoke-wrapper.sh

# 4) 起栈
docker compose up -d
# 打开 http://<host>:2000 → 首次访问创建管理员账号
```

### 接入 Apple 账号

账号登录由 **wrapper-lite** 负责（本节只涉及「解密权限」）。两种方式：

```ini
# .env —— 首次登录用，成功后会话会缓存进 data/wrapper/，可以再留空
USERNAME=your-apple-id@example.com
PASSWORD=your-apple-password
```

```bash
docker compose up -d wrapper-lite
docker compose logs -f wrapper-lite
```

- 需要 **Apple Music 付费订阅**。
- 登录成功后会话缓存在 `data/wrapper/`，**之后可把密码清空**。
- 若 Apple 要求 **2FA**：容器日志会提示，到网页「配置」页提交 6 位验证码即可
  （网页写入 `data/wrapper/2fa.txt`，wrapper-lite 轮询读取）。
- Apple 的 **媒体 token**（`media-user-token` / `authorization-token`）属于「下载相关」，
  写在 `config.yaml` 里，见下一节。

## ⚙️ 配置分层

只有三个地方，各管一摊，互不重叠：

| 放什么 | 放哪里 | 怎么改 |
|---|---|---|
| **部署相关**：端口、绑定、路径、权限、时区、出网代理、并发、任务超时、站点管理员口令、会话 | `.env` | 改文件 → `docker compose up -d` |
| **下载相关**：音质、歌词、封面、命名模板、转码、地区/语言、Apple 凭据 | `config.yaml`（引擎配置） | 改文件 → **重启容器**（单文件 bind mount 认 inode） |
| **只影响一次**：本次任务的歌词覆盖、**元数据地区** | 网页「新建下载」里的「本次任务临时覆盖」/「元数据地区」 | 直接勾选，不落盘 |

网页的「配置」页会**只读**地展示以上全部内容（凭据自动打码），
包括实际生效的 `storefront` / `language` 与 `config.yaml` 全文 —— 不用登录宿主机就能核对。

### 元数据地区（把罗马音标题换成日文原名）

**问题**：同一首歌，Apple 给不同店面配的元数据不同 —— 大陆区常见英文/罗马音
（`Hanabira`、`Kawakiwoameku`），日区是原名（`はなびら`、`カワキヲアメク`）。
引擎的**文件名与内嵌标签直接取自「你查询的那个店面」**，所以想要日文原名就得让引擎按日区取数。

**怎么做**：引擎的地区**只从 URL 取**（`checkUrl`），`config.yaml` 里的 `storefront` 只影响引擎自己的搜索。
因此「本次任务用日区元数据」在实现上就是**改写链接里的地区段**：网页新建下载时选「元数据地区 = 日本 jp」，
服务端把 `music.apple.com/cn/…` 改成 `music.apple.com/jp/…` 再交给引擎（音频是同一条记录，只是元数据换了写法）。

三种结果，**在点下载之前**就会显示：

| 情况 | 行为 |
|---|---|
| 目标区有这条记录 | 按目标区执行（文件名/标签是日文原名） |
| 目标区没有（目录 404） | **回退**到链接原本的地区，并在预览与任务页注明原因 |
| 查询失败（网络/token） | 同样回退，但提示写「无法确认」而不是「没有」——两者含义不同，不混为一谈 |

播放列表与艺人链接**不做预检**（拿不到「整条记录」的概念），按目标区直接跑，失败会在任务里报错。

勾选「目标区没有时自动找等价记录」后，会先在目标区搜一次：**只有艺人名与时长都一致（±1 秒）**
才改用搜到的另一条记录（例如 EGOIST《Departures》在日区是 2020 再版，id 不同、标题才是日文原名）；
任何一项对不上**一律回退，绝不替换**。搜索词从「艺人 + 完整曲名」逐步放宽到「艺人 + 曲名首词」「仅艺人」，
因为实测完整罗马音标题在日区**一条都搜不到**，缩短后反而能命中。

> ⚠️ 风险：同名不同版本很多（翻唱、现场版、TV size、钢琴版）。艺人+时长是目前最可靠的两个信号，
> 但仍不能保证 100% 正确 —— 换用后请到任务页核对落盘的曲目名与时长，确认无误再删旧版本。
> **不勾选则只回退、绝不替换。** 自动匹配只对单曲链接生效（整张专辑换记录会改变任务规模）。

> 另一个已验证的坑：目录查询的 `language` 会覆盖标题语言 —— 日区 + `language: en-US`
> 拿到的仍是英文/罗马音标题。想稳定拿日文原名，别把 `language`/`LANGUAGE` 设成 `en-US`。

### `.env` 键

| 键 | 默认 | 说明 |
|---|---|---|
| `USERNAME` / `PASSWORD` | — | Apple ID（仅 wrapper-lite 首次登录需要） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 空 | 站点管理员；留空则首次打开网页时创建 |
| `SESSION_SECRET` / `SESSION_DAYS` | 自动生成 / `30` | 会话签名密钥与有效期 |
| `MUSIC_DIR` | `./music` | 音乐落盘目录（宿主绝对路径） |
| `WEB_BIND` / `WEB_PORT` | `0.0.0.0` / `2000` | 网页监听 |
| `TRUST_PROXY` | `false` | 反向代理后置 `true` 才信任 `X-Forwarded-*` |
| `TZ` | `UTC` | 时区（日志时间与文件 mtime） |
| `PUID` / `PGID` | `1000` / `100` | 期望的宿主属主（需与 compose 的 `user:` 一致；仅用于自检提示） |
| `FILE_MODE` | `666` | 下载后统一文件权限；`keep` 表示沿用引擎默认 `600` |
| `JOB_CONCURRENCY` | `1` | 并发任务数（Apple 会按 IP 限流，建议保持 1） |
| `JOB_TIMEOUT_SEC` / `JOB_LOG_LINES` | `7200` / `2000` | 单任务超时与日志保留行数 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 空 | 出网代理（引擎下载媒体流走系统代理） |
| `STOREFRONT` / `LANGUAGE` | `us` / `en-US` | **仅兜底**：`config.yaml` 里写了就以那里为准 |

### `config.yaml` 键

见仓库根的 `config.example.yaml`（逐项注释，含 50 余个键：`alac-max`、`lrc-type`、
`convert-*`、`tag-*`、`save-animated-artwork`、`proxy`…）。把 `config.yaml` 当作
「引擎的配置文件」而不是「本项目的配置文件」，上游新增的键都能直接用，无需改代码。

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（免登录） |
| POST | `/api/setup` | 首次运行创建管理员 |
| POST | `/api/login` · `/api/logout` | 会话 |
| GET | `/api/codecs?url=&region=&autoMatch=1` | 解析链接并返回**真实可用编码** + 地区计划（会不会回退 / 有没有自动匹配） |
| GET | `/api/search?q=` | Apple Music 目录搜索 |
| GET | `/api/jobs` · POST `/api/jobs` | 任务列表 / 创建（`options` 里的键=本次临时覆盖；`region` / `autoMatch` = 元数据地区） |
| POST | `/api/jobs/:id/retry` | 重试：克隆原任务（引擎会跳过已下载的曲目，只补失败的几首） |
| GET | `/api/jobs/:id/events` | SSE：`hello` / `log` / `status` |
| GET | `/api/config` | 只读配置快照（凭据打码） |
| POST | `/api/apple/2fa` | 提交 Apple 2FA 验证码 |

> 没有写配置的接口：配置要么在文件里，要么是「只对本次任务有效」的覆盖项。

## 🧱 构建相关改动（相对上游）

- **`Dockerfile.amdl`**：wrapper-lite 的 CMake 用 `FetchContent`（内部 `git clone`）拉取
  cJSON / Dobby。为在 git 受限环境下可构建，依赖被 vendor 到 `wrapper-lite/deps/` 并通过
  `-DFETCHCONTENT_SOURCE_DIR_*` 注入；同时把 `-j$(nproc)` 收敛为 `-j${BUILD_JOBS}`。
- **`Dockerfile.web`** 内置三道**构建期自检**，把「只有点下载时才暴露」的错误提前到构建阶段：
  引擎二进制能否 `execve`（musl/glibc 不匹配）、Temari 自带 cdylib 是否可解析、
  系统 CA 证书是否存在（Go 用系统 CA，而 `node:*-slim` 不带）。
- 引擎配置**按任务覆盖**：引擎从进程 cwd 读 `config.yaml`，故每个任务生成私有配置目录。

详细原因与更多坑（含 bind mount 的 inode 陷阱、entrypoint 的 `chown` 影响等）见
[`docs/DESIGN.md`](docs/DESIGN.md)。

### 上游源码获取（git 不可用时）

部分受限网络会重置 TLS（`git` 失败但 `curl` 正常），此时改用 tarball：

```bash
mkdir -p wrapper-lite engine wrapper-lite/deps/cjson wrapper-lite/deps/dobby
curl -sL https://codeload.github.com/WorldObservationLog/wrapper/tar.gz/refs/heads/lite \
  | tar xz --strip-components=1 -C wrapper-lite
curl -sL https://codeload.github.com/DaveGamble/cJSON/tar.gz/refs/tags/v1.7.19 \
  | tar xz -C wrapper-lite/deps/cjson --strip-components=1
curl -sL https://codeload.github.com/BepInEx/Dobby/tar.gz/refs/heads/master \
  | tar xz -C wrapper-lite/deps/dobby --strip-components=1
curl -sL https://github.com/zhaarey/apple-music-downloader/archive/refs/heads/main.tar.gz \
  | tar xz --strip-components=1 -C engine
```

## ⚠️ 已知限制

- `wrapper-lite` 的 rootless 启动器需要在容器内挂载 procfs，**部分内核不允许**
  （实测某 QNAP 内核上 `cap_add: SYS_ADMIN` 与「fork 进新 PID namespace」两种绕法均无效），
  因此默认使用 `privileged: true`（与上游 README 的做法一致）。若你的环境支持，
  可改用上游的 `wrapper-lite-qemu`，无需特权。
- 引擎写出的文件默认 `600`，本项目下载后统一为 `FILE_MODE`；若媒体服务器以别的 uid 运行，
  保持 `666` 或把其 `PUID` 设为文件属主。
- Apple 会按 IP 限流，**不建议**提高 `JOB_CONCURRENCY`。
- **地区改写只管元数据，不管权限**：能下什么由**账号所在店面**的授权决定，
  贴外区链接不会凭空解锁该区独占曲目（版权上架与否是另一回事）。
- **自动匹配不是万无一失**：靠 Apple 搜索 + 「艺人 + 时长 ±1s」判断，可能找不到（于是回退），
  理论上也可能匹配到同名翻唱；任务页会列出匹配到的记录名与时长差，请自行核对。
- **地区选项对播放列表/艺人不做预检**：会按目标区直接跑，失败表现为任务报错。
- 任务状态存于 JSON 文件（原子写）；数据量大时可平滑替换为 SQLite。
- 仅在 `linux/amd64` 上验证过（上游二进制与 ffmpeg 静态包的原因）。

## 🙏 致谢

本项目站在这些开源项目的肩膀上，特此致谢：

| 项目 | 在本项目中的角色 | 许可证 |
|---|---|---|
| [**WorldObservationLog/wrapper**](https://github.com/WorldObservationLog/wrapper)（`lite` 分支） | **解密后端**：Apple Music 账号会话，提供 `/m3u8`、`/key`、`/lyrics`、`/license`、`/webplayback` | MIT |
| [**WorldObservationLog/Temari**](https://github.com/WorldObservationLog/Temari) | **FairPlay Streaming 解密库**（由 ripper 通过 Go 绑定调用） | MIT |
| [**zhaarey/apple-music-downloader**](https://github.com/zhaarey/apple-music-downloader) | **ripper 引擎**：目录与元数据、m3u8、分片下载、标签与封面写入 | 上游未声明许可证 |
| [WorldObservationLog/AppleMusicDecrypt](https://github.com/WorldObservationLog/AppleMusicDecrypt) | 配置与用法参考（其 v2 走 wrapper-manager） | AGPL-3.0 |
| [glomatico/gamdl](https://github.com/glomatico/gamdl) | 生态中的经典实现，本栈上游的灵感来源之一 | MIT |
| [mwader/static-ffmpeg](https://hub.docker.com/r/mwader/static-ffmpeg) | 运行时静态 ffmpeg（转码 / 动画封面） | 见其镜像说明（含 GPL 组件） |
| [node](https://hub.docker.com/_/node) · [golang](https://hub.docker.com/_/golang) | 构建与运行时基础镜像 | 各自许可证 |

也感谢 [WorldObservationLog](https://github.com/WorldObservationLog) 与
[zhaarey](https://github.com/zhaarey) 的维护者。

## 📜 许可证

- 本仓库包含的代码（`web/`、`Dockerfile.*`、脚本、文档）：**MIT**，见 [`LICENSE`](LICENSE)。
- `WorldObservationLog/wrapper`、`Temari` 为 **MIT**；`AppleMusicDecrypt` 为 **AGPL-3.0**。
- `zhaarey/apple-music-downloader` **未声明许可证**：本项目只把它作为**本地构建的依赖**使用，
  不随镜像或仓库分发；如需再分发请先获得其作者许可。
- 上游源码（`wrapper-lite/`、`engine/`）**不在本仓库中**，请按上文步骤自行获取。

## ⚖️ 合规声明

使用本项目需要 Apple Music **付费订阅**。绕过 DRM 在多数司法辖区受 DMCA §1201 / EUCD 第 6 条
等约束，请**仅用于个人自用归档**，不要公开暴露服务，也不要再分发下载内容。
