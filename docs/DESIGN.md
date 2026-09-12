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
| 改了挂载的 `config.yaml` 但容器里没变 | ① `sed -i` 会换 inode，而 bind mount 锁定启动时的 inode；② 单文件 bind mount 不跟随路径替换 | 修改后**重启容器**重新解析挂载；写入用 `cat > file` 原地覆盖 |
| 网页提交 2FA 写不进 `data/wrapper/` | 上游 entrypoint 会 `chown -R root:root` 该目录 | 预置 `2fa.txt` 并 `chmod 666`（`chown` 不改模式位） |
| rootless 启动器起不来 | 它需要在容器内挂载 procfs，部分内核不允许（`cap_add: SYS_ADMIN` 亦无效） | 使用 `privileged: true`（与上游 README 一致），或改用上游的 `wrapper-lite-qemu` |

## 5. 数据与状态

- 前端状态：`data/web/amdl-web.json`（账号、任务、结果）+ `session.secret`（会话签名密钥），均为原子写。
- 每个任务的引擎配置：`data/web/jobcfg/<id>/config.yaml`。
- wrapper 的账号会话与 token 缓存：`data/wrapper/`（**含解密所需凭据，注意保护**）。
- 下载落盘：由 `.env` 的 `MUSIC_DIR` 决定，容器内固定为 `/downloads`。
