#!/bin/sh
# 部署验证：分两段，因为「有凭据」和「无凭据」能验证的东西不同。
#   A) 无凭据即可验证：解密后端启动链路、前端站点、登录页、健康检查
#   B) 需要 Apple 凭据：真实下载
#
# 用法：sh verify-stack.sh      （在项目根目录执行）
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

WEB_PORT="${WEB_PORT:-2000}"
WEB_BIND="${WEB_BIND:-127.0.0.1}"
BASE="http://${WEB_BIND}:${WEB_PORT}"

echo "############ A1) wrapper-lite 冒烟（无凭据）############"
sh smoke-wrapper.sh || echo "(冒烟失败，详见上方输出)"

echo
echo "############ A2) 拉起服务 ############"
# wrapper-lite 在没有 Apple 凭据时会退出（上游 entrypoint 的硬性检查），
# 因此这里先只起前端：站点即可用（登录 / 搜索 / 解析链接），下载留到填好 .env 之后。
docker compose up -d --no-deps amdl-web
sleep 8
docker compose ps

echo
echo "############ A3) 健康检查 ############"
curl -s -m 10 "$BASE/healthz" || echo "(无响应)"
echo

echo "############ A4) 页面状态码 ############"
for p in /login /healthz /; do
    curl -s -m 10 -o /dev/null -w "GET $p -> %{http_code}\n" "$BASE$p"
done

echo
echo "############ A5) 前端日志 ############"
docker compose logs --tail=20 amdl-web

echo
echo "############ B) 填好 Apple 凭据后再执行 ############"
cat <<'EOF'
  1) 编辑 .env：填 USERNAME / PASSWORD（Apple ID）
  2) docker compose up -d wrapper-lite
  3) 若日志提示需要 2FA：到网页「设置」页提交 6 位验证码
     （前端写入 data/wrapper/2fa.txt，wrapper 轮询读取）
  4) 验证真实下载：docker compose --profile cli run --rm engine '<music.apple.com 链接>' --json
  5) 检查落盘：ls -R music/
EOF
