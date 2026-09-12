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
- **歌词可按任务配置**：嵌入文件 / 另存 `.lrc` / 逐行或逐字 / 翻译或罗马音 / `lrc` 或 `ttml`。
- **下载后统一文件权限**（默认 `666`），便于以其它 uid 运行的媒体服务器读取。
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

编辑 `.env`：

```ini
USERNAME=your-apple-id@example.com
PASSWORD=your-apple-password
```

```bash
docker compose up -d wrapper-lite
docker compose logs -f wrapper-lite
```

- 需要 **Apple Music 付费订阅**。
- 登录成功后会话会缓存进 `data/wrapper/`，**之后可把密码留空**。
- 若 Apple 要求 **2FA**：容器日志会提示，到网页「设置」页提交 6 位验证码即可。
- 前端**不保存、不代持** Apple 凭据；凭据只注入 wrapper 容器。

## ⚙️ 配置（`.env`）

| 键 | 默认 | 说明 |
|---|---|---|
| `USERNAME` / `PASSWORD` | — | Apple ID（仅 wrapper 首次登录需要） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 空 | 站点管理员；留空则首次打开网页时创建 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥（留空则持久化到 `data/web/session.secret`） |
| `MUSIC_DIR` | `./music` | 音乐落盘目录（宿主绝对路径） |
| `STOREFRONT` / `LANGUAGE` | `us` / `en-US` | 目录搜索与元数据地区 |
| `WEB_BIND` / `WEB_PORT` | `0.0.0.0` / `2000` | 网页监听 |
| `JOB_CONCURRENCY` | `1` | 并发任务数（Apple 会按 IP 限流，建议保持 1） |
| `FILE_MODE` | `666` | 下载后统一文件权限；`keep` 表示沿用引擎默认 `600` |
| `JOB_TIMEOUT_SEC` / `JOB_LOG_LINES` | `7200` / `2000` | 单任务超时与日志保留行数 |

## 🔌 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（免登录） |
| POST | `/api/setup` | 首次运行创建管理员 |
| POST | `/api/login` · `/api/logout` | 会话 |
| GET | `/api/codecs?url=` | 解析链接并返回**真实可用编码** |
| GET | `/api/search?q=` | Apple Music 目录搜索 |
| GET | `/api/jobs` · POST `/api/jobs` | 任务列表 / 创建（可带歌词选项） |
| GET | `/api/jobs/:id/events` | SSE：`hello` / `log` / `status` |
| POST | `/api/apple/2fa` | 提交 Apple 2FA 验证码 |

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
