#!/bin/bash
# 파트 연습기 실행 스크립트
#   bash run.sh
# 같은 와이파이의 폰·태블릿에서도 접속할 수 있게 0.0.0.0 으로 연다.
cd "$(dirname "$0")" || exit 1

# 이미 8000 포트를 쓰는 서버가 있으면 정리
OLD=$(lsof -ti :8000 -sTCP:LISTEN 2>/dev/null)
[ -n "$OLD" ] && kill -9 $OLD 2>/dev/null

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

echo "────────────────────────────────────────"
echo " 이 컴퓨터에서 :  http://localhost:8000"
[ -n "$IP" ] && echo " 폰·태블릿에서 :  http://$IP:8000   (같은 와이파이)"
echo "────────────────────────────────────────"

exec .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000
