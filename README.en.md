# amdl-web

A self-hosted Apple Music download site: **log in from the browser → paste a link → get lossless audio**,
deployed with Docker.

This repository provides the web UI and the Docker orchestration; decryption and downloading are built on the
open-source components credited below.

[中文说明 →](README.md)

---

## ✨ Features

- **Web login → paste a link → download.** No CLI needed; jobs stream live logs over SSE and results are recorded.
- **Codec choices come from the track itself.** The link is resolved first and Apple's catalog
  `audioTraits` decide which of Lossless / Dolby Atmos / AAC are actually offered (albums and playlists
  use the union across their tracks) — no hardcoded option list.
- **No Widevine CDM required.** Uses the FairPlay path, so a single `wrapper-lite` service is enough.
- **No `docker.sock` mount and no privileged frontend container.** The ripper runs inside the frontend
  container and is invoked as a child process.
- **Lyrics on by default**: embedded into tags plus a sidecar `.lrc`; line- or syllable-timed /
  translation or romanization / `lrc` or `ttml` remain per-job overridable.
- **One failed track is not a wasted job**: the engine only prints its file list when everything
  succeeds, so on failure the web layer recovers what actually landed (by mtime) — the job becomes
  `partial` instead of `failed`, permissions are still normalised, and a retry button is offered.
- **Normalized file permissions after download** (default `666`) so media servers running as another uid
  can read the files.
- **Apple 2FA code can be submitted in the web UI** — no need to touch files on the host.
- **Per-job metadata region**: pick “Japan jp” and the link is rewritten to that storefront, so file names
  and tags get the native titles; missing records **fall back** to the link's region with a visible notice,
  and an optional "auto-find an equivalent record" mode requires a matching artist *and* duration (with risk noted).
- Lightweight frontend: Express + EJS + a single CSS file, no frontend framework.

## 🏗 Architecture

```
Browser (login / link resolution / live job log / library)
   │ HTTP + SSE
   ▼
amdl-web container ── frontend (Node + Express + EJS)
   │  spawns a child process (one private config.yaml per job)
   ▼
apple-music-dl ── ripper (Go; uses Temari to perform FairPlay decryption)
   │ HTTP :12340
   ▼
wrapper-lite ── decryption backend (Apple Music account session + /m3u8 /key /lyrics /license)
   │
   ▼
Music directory (ALAC / Atmos / AAC)
```

Only two services run: `wrapper-lite` (the single "backend service") and `amdl-web` (frontend + ripper).
See [`docs/DESIGN.md`](docs/DESIGN.md) for design notes.

## 📁 Layout

```
.
├── docker-compose.yml        # deployment stack (wrapper-lite + amdl-web)
├── Dockerfile.web            # combined image: Go-built ripper + Node-built frontend + slim runtime
├── Dockerfile.amdl           # build patch for wrapper-lite (see "Build changes")
├── .env.example              # all configuration and secrets live here (copy to .env)
├── config.example.yaml       # engine config template (exit-on-error / output dirs / lyrics)
├── web/                      # frontend source
│   ├── src/                  #   Express app, auth, Apple catalog client, ripper adapter, queue
│   ├── views/                #   EJS templates
│   ├── public/               #   stylesheet and browser script (no framework)
│   └── test/                 #   unit tests (engine output parsing / link parsing)
├── smoke-wrapper.sh          # credential-free smoke test (startup path and /status)
├── verify-stack.sh           # deployment verification script
└── docs/DESIGN.md            # design notes and "builds fine, breaks at runtime" pitfalls
```

## 🚀 Quick start

Requirements: Docker + Compose v2 on a `linux/amd64` host.

```bash
git clone <this repo> amdl-web && cd amdl-web
cp .env.example .env                 # fill in your Apple account and music directory
cp config.example.yaml config.yaml   # optional: tweak engine defaults

# 1) fetch upstream sources (see "Fetching upstream sources" if git is unusable)
git clone -b lite https://github.com/WorldObservationLog/wrapper.git wrapper-lite
git clone https://github.com/zhaarey/apple-music-downloader.git engine

# 2) build (wrapper-lite cross-compiles for Android targets; this takes a while)
docker compose build

# 3) smoke test: verify the decryption backend starts (no Apple credentials needed)
sh smoke-wrapper.sh

# 4) start the stack
docker compose up -d
# open http://<host>:2000 → create the admin account on first visit
```

### Connecting your Apple account

Account login is handled by **wrapper-lite** (this section is only about decryption rights):

```ini
# .env — needed for the first login; the session is cached under data/wrapper/ afterwards
USERNAME=your-apple-id@example.com
PASSWORD=your-apple-password
```

```bash
docker compose up -d wrapper-lite
docker compose logs -f wrapper-lite
```

- An **active Apple Music subscription** is required.
- After a successful login the session is cached under `data/wrapper/`, so **the password can be left
  empty afterwards**.
- If Apple asks for **2FA**, the container log says so — submit the 6-digit code on the web UI's
  **Config** page (the UI writes `data/wrapper/2fa.txt`, which wrapper-lite polls).
- Your Apple **media tokens** (`media-user-token` / `authorization-token`) are download-related and
  live in `config.yaml` — see the next section.

## ⚙️ Configuration layers

Three places, each with exactly one job:

| What | Where | How to change |
|---|---|---|
| **Deployment**: port, bind address, paths, permissions, timezone, egress proxy, concurrency, timeouts, admin password, sessions | `.env` | edit the file, then `docker compose up -d` |
| **Download semantics**: quality, lyrics, artwork, naming templates, conversion, storefront/language, Apple credentials | `config.yaml` (engine config) | edit the file, then **restart the container** (a single-file bind mount follows the inode) |
| **One-off overrides**: lyrics flags, **metadata region** for a single job | web UI → "per-job override" / "metadata region" | tick it; nothing is persisted |

The web UI's **Config** page renders all of the above **read-only** (credentials masked), including the
effective `storefront` / `language` and the whole `config.yaml` — no need to SSH into the host to check.

### Metadata region (romanized titles → native titles)

**The problem**: Apple localizes metadata per storefront. The same song appears as `Hanabira` in one
storefront and `はなびら` in another, and the engine takes **file names and embedded tags straight from
whichever storefront you queried**.

**The trick**: the engine takes the region **from the URL only** (`checkUrl`); `storefront` in
`config.yaml` merely affects the engine's own search command. So "use Japanese metadata for this job"
is implemented as **rewriting the region segment of the link**: pick “metadata region = Japan jp” and the
server turns `music.apple.com/cn/…` into `music.apple.com/jp/…` before handing it to the engine
(same catalog record, different metadata).

Three outcomes, all shown **before you press Download**:

| Case | Behaviour |
|---|---|
| Target region has the record | Job runs against that region (native titles) |
| Target region lacks it (catalog 404) | **Falls back** to the link's own region, with the reason shown on the preview and job page |
| Probe failed (network/token) | Also falls back, but the message says "could not confirm" instead of "not available" — the two are not the same thing |

Playlists and artist links are **not pre-checked** (there is no single "record" to check); they run against
the target region directly and surface the engine error if that region has nothing.

**The search page picks a storefront too** (same selector as the overview page): search "Hanabira" with the
storefront set to Japan and you get the 「はなびら」 record itself; its download buttons carry that storefront
into the job. The page states the search scope, falling back to `storefront` from `config.yaml` when unset —
in practice, **finding the record on the search page** beats pasting a CN link and hoping auto-matching finds it.

With **"auto-find an equivalent record"** enabled, the target region is searched first: an alternative
record is used **only if the artist name matches and the duration is within ±1 s** (e.g. EGOIST's
*Departures* exists in the JP store as a 2020 reissue with a different id and the native title). If either
check fails, it **always falls back — it never substitutes**. Search queries widen from
“artist + full title” to “artist + first word” to “artist only”, because the full romanized title was
measured to return **zero** results in the JP storefront.

> ⚠️ Risk: many same-name variants exist (covers, live takes, TV-size edits). Artist + duration are the
> most reliable signals available but are not infallible — after a substitution, verify the landed track
> name and duration on the job page before deleting the old romanized copy.
> **Without the checkbox it only falls back, never substitutes.** Auto-matching applies to single-song
> links only (swapping an album record would change the scope of the job).

> Another verified pitfall: the catalog `language` overrides title language — JP storefront plus
> `language: en-US` still yields English/romanized titles. Keep `language`/`LANGUAGE` away from `en-US`
> if you want native titles.

### `.env` keys

| Key | Default | Description |
|---|---|---|
| `USERNAME` / `PASSWORD` | — | Apple ID (only needed for wrapper-lite's first login) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | empty | Site admin; leave empty to create it from the web UI |
| `SESSION_SECRET` / `SESSION_DAYS` | auto / `30` | Session signing key and lifetime |
| `MUSIC_DIR` | `./music` | Output directory on the host |
| `WEB_BIND` / `WEB_PORT` | `0.0.0.0` / `2000` | Web listener |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy to trust `X-Forwarded-*` |
| `TZ` | `UTC` | Timezone (log timestamps, file mtimes) |
| `PUID` / `PGID` | `1000` / `100` | Expected host ownership (must match compose's `user:`; shown for self-check only) |
| `FILE_MODE` | `666` | Permission applied to downloaded files; `keep` keeps the engine default `600` |
| `JOB_CONCURRENCY` | `1` | Concurrent jobs (Apple rate-limits by IP; keep at 1) |
| `JOB_TIMEOUT_SEC` / `JOB_LOG_LINES` | `7200` / `2000` | Per-job timeout and retained log lines |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | empty | Egress proxy (the engine downloads media through the system proxy) |
| `STOREFRONT` / `LANGUAGE` | `us` / `en-US` | **Fallback only** — `config.yaml` wins when it sets them |

### `config.yaml` keys

See `config.example.yaml` in the repo root: a fully commented template covering 50+ keys
(`alac-max`, `lrc-type`, `convert-*`, `tag-*`, `save-animated-artwork`, `proxy`, …). Treat it as
**the engine's config file** rather than this project's, so new upstream keys work without code changes.

## 🔌 HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Health check (no auth) |
| POST | `/api/setup` | Create the first admin account |
| POST | `/api/login` · `/api/logout` | Session |
| GET | `/api/codecs?url=&region=&autoMatch=1` | Resolve a link and return its **real available codecs** plus the region plan (fallback / auto-match) |
| GET | `/api/search?q=&region=` | Apple Music catalog search (`region` selects the storefront; defaults to `storefront` from `config.yaml`) |
| GET | `/api/jobs` · POST `/api/jobs` | List / create jobs (keys inside `options` = per-job overrides; `region` / `autoMatch` = metadata region) |
| POST | `/api/jobs/:id/retry` | Retry: clones the job (the engine skips tracks already on disk, so only failures are re-fetched) |
| GET | `/api/jobs/:id/events` | SSE: `hello` / `log` / `status` |
| GET | `/api/config` | Read-only config snapshot (credentials masked) |
| POST | `/api/apple/2fa` | Submit the Apple 2FA code |

> There is deliberately no config write endpoint: config lives in files, or is a per-job override
> that lasts for exactly one download.

## 🧱 Build changes relative to upstream

- **`Dockerfile.amdl`**: wrapper-lite's CMake pulls cJSON and Dobby through `FetchContent`
  (which uses `git clone` internally). To build on hosts where git is unusable, those dependencies are
  vendored into `wrapper-lite/deps/` and injected via `-DFETCHCONTENT_SOURCE_DIR_*`; `-j$(nproc)` is
  also narrowed to `-j${BUILD_JOBS}`.
- **`Dockerfile.web`** runs three **build-time self-checks** that turn "only fails when you click
  Download" errors into build failures: whether the engine binary can `execve` (musl/glibc mismatch),
  whether Temari's bundled cdylib resolves, and whether system CA certificates are present
  (Go uses the system CA store, while `node:*-slim` does not ship it).
- **Per-job engine configuration**: the engine reads `config.yaml` from its process cwd, so each job gets
  its own config directory.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the reasoning and further pitfalls (bind-mount inode trap,
the wrapper entrypoint's `chown`, and others).

### Fetching upstream sources (when git is unusable)

Some restricted networks reset TLS (git fails while `curl` works). Use tarballs instead:

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

## ⚠️ Known limitations

- `wrapper-lite`'s rootless launcher mounts procfs inside the container, which **some kernels refuse**.
  On one tested QNAP kernel neither `cap_add: SYS_ADMIN` nor patching in a fork into a new PID namespace
  helped, so `privileged: true` is the default (matching the upstream README). If your kernel allows it,
  upstream's `wrapper-lite-qemu` launcher avoids the privilege requirement.
- The engine writes files as `600`; this project normalizes them to `FILE_MODE`. If your media server runs
  as another uid, keep `666` or set its `PUID` to the file owner.
- Apple rate-limits by IP — **do not** raise `JOB_CONCURRENCY`.
- **Region rewriting only affects metadata, not entitlements**: what you can download is decided by the
  storefront your account is entitled in; pasting a foreign link does not unlock region-exclusive tracks.
- **Auto-matching is not foolproof**: it relies on Apple search plus "artist + duration ±1 s", so it may
  find nothing (then it falls back) and could in theory pick a same-name cover. The job page lists the
  matched record and the duration delta for you to verify.
- **Region selection does not pre-check playlists or artists** — they run against the target region and
  fail visibly if that region has nothing.
- Job state is kept in a JSON file (atomic writes); swap in SQLite if the volume grows.
- Only verified on `linux/amd64` (upstream binaries and the static ffmpeg build).

## 🙏 Credits

This project stands on the shoulders of these open-source projects:

| Project | Role here | License |
|---|---|---|
| [**WorldObservationLog/wrapper**](https://github.com/WorldObservationLog/wrapper) (`lite` branch) | **Decryption backend**: Apple Music account session, `/m3u8`, `/key`, `/lyrics`, `/license`, `/webplayback` | MIT |
| [**WorldObservationLog/Temari**](https://github.com/WorldObservationLog/Temari) | **FairPlay Streaming decryption library** (called by the ripper through its Go binding) | MIT |
| [**zhaarey/apple-music-downloader**](https://github.com/zhaarey/apple-music-downloader) | **Ripper engine**: catalog and metadata, m3u8, segment download, tagging and artwork | No license declared upstream |
| [WorldObservationLog/AppleMusicDecrypt](https://github.com/WorldObservationLog/AppleMusicDecrypt) | Configuration and usage reference (its v2 uses wrapper-manager) | AGPL-3.0 |
| [glomatico/gamdl](https://github.com/glomatico/gamdl) | A classic implementation in this ecosystem and one of the inspirations for the stack above | MIT |
| [mwader/static-ffmpeg](https://hub.docker.com/r/mwader/static-ffmpeg) | Static ffmpeg at runtime (transcoding / animated artwork) | See image notes (includes GPL components) |
| [node](https://hub.docker.com/_/node) · [golang](https://hub.docker.com/_/golang) | Base images for building and running | Their respective licenses |

Thanks also to the maintainers of [WorldObservationLog](https://github.com/WorldObservationLog) and
[zhaarey](https://github.com/zhaarey).

## 📜 License

- This project's own code (`web/`, `Dockerfile.*`, scripts, docs): **MIT**, see [`LICENSE`](LICENSE).
- `WorldObservationLog/wrapper` and `Temari` are **MIT**; `AppleMusicDecrypt` is **AGPL-3.0**.
- `zhaarey/apple-music-downloader` **declares no license**: this project only uses it as a
  **locally built dependency** and does not redistribute it in the repository or image. Obtain the
  author's permission before redistributing it.
- Upstream sources (`wrapper-lite/`, `engine/`) are **not** part of this repository — fetch them as
  described above.

## ⚖️ Legal notice

Using this project requires a **paid Apple Music subscription**. Circumventing DRM is restricted under
DMCA §1201 / EUCD Art. 6 and similar laws in many jurisdictions. Use it **for personal archiving only**,
do not expose the service publicly, and do not redistribute downloaded content.
