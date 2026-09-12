#!/bin/sh
# wrapper-lite 冒烟测试：验证解密后端能否启动，**不需要 Apple 凭据**。
#
# 为什么需要单独的冒烟测试：
#   * 上游 entrypoint 在账号库缺失时强制要求 USERNAME/PASSWORD，否则直接 exit 1；
#     这里用 --entrypoint 绕过它，以「服务模式」启动，足以证明容器环境与启动链路可用；
#   * 服务模式下 /status 返回 200（regions 为空是正常的，还没有登录）；
#   * 启动约需 30–60 秒，健康检查必须给足时间。
#
# 用法：sh smoke-wrapper.sh      （在项目根目录执行）
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="${WRAPPER_IMAGE:-amdl-web/wrapper-lite:local}"
NAME="${SMOKE_NAME:-amdl-wrapper-smoke}"
PORT="${SMOKE_PORT:-12340}"
SMOKE_DATA="$HERE/data/smoke"

rm -rf "$SMOKE_DATA"
mkdir -p "$SMOKE_DATA"
# 启动器在子 user namespace 中运行，没有 DAC 覆盖权，宿主机上非 root 属主的目录必须放开写权限
chmod 777 "$SMOKE_DATA"

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "=== 启动冒烟容器（服务模式，无凭据）==="
docker run -d --name "$NAME" \
    --privileged \
    -v "$SMOKE_DATA":/app/rootfs/data \
    -p "127.0.0.1:${PORT}:12340" \
    --entrypoint /app/wrapper-lite-rootless \
    "$IMG" --base-dir /data --host 0.0.0.0 --port 12340

echo "=== 等待服务就绪（最多 120 秒）==="
i=0
ok=0
while [ "$i" -lt 24 ]; do
    sleep 5
    i=$((i + 1))
    CODE=$(curl -s -m 5 -o /tmp/smoke-status.json -w "%{http_code}" "http://127.0.0.1:${PORT}/status" 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ]; then
        echo "    /status -> 200（$((i * 5))s）：$(cat /tmp/smoke-status.json)"
        ok=1
        break
    fi
done

echo "=== 容器状态 ==="
docker ps -a --filter "name=$NAME" --format '{{.Names}} | {{.Status}}'

echo "=== 日志（末 20 行）==="
docker logs "$NAME" 2>&1 | tail -20

echo "=== 清理 ==="
docker rm -f "$NAME" >/dev/null && echo "已移除容器 $NAME"
rm -rf "$SMOKE_DATA"
rm -f /tmp/smoke-status.json

if [ "$ok" = "0" ]; then
    echo "冒烟测试失败：/status 未在 120 秒内返回 200"
    exit 1
fi
echo "冒烟测试通过"
