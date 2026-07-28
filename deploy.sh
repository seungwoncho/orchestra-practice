#!/bin/bash
# GitHub Pages 로 공개 배포한다.
#   bash deploy.sh
# 처음 한 번은 GitHub 로그인 창이 뜬다. 그 뒤로는 이 명령만 다시 실행하면 갱신된다.
set -e
cd "$(dirname "$0")"

GH="$HOME/orchestra-tools/bin/gh"
REPO="orchestra-practice"

if [ ! -x "$GH" ]; then
  echo "GitHub CLI 가 없습니다. 다시 설치가 필요해요."
  exit 1
fi

# 1) 로그인 (이미 돼 있으면 건너뜀)
if ! "$GH" auth status >/dev/null 2>&1; then
  echo "──────────────────────────────────────────"
  echo " GitHub 로그인이 필요합니다."
  echo " 화면에 나오는 8자리 코드를 복사한 뒤,"
  echo " 열리는 브라우저에 붙여넣고 승인해 주세요."
  echo "──────────────────────────────────────────"
  "$GH" auth login --hostname github.com --git-protocol https --web
fi

USER=$("$GH" api user --jq .login)
echo "로그인 계정: $USER"

# 2) 최신 상태로 다시 굽고 커밋
.venv/bin/python build_static.py >/dev/null 2>&1 || true
git add -A
git diff --cached --quiet || git commit -q -m "배포 갱신"

# 3) 저장소가 없으면 만들고, 있으면 그대로 밀어 넣기
if "$GH" repo view "$USER/$REPO" >/dev/null 2>&1; then
  echo "기존 저장소에 반영합니다: $USER/$REPO"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$USER/$REPO.git"
  git push -q origin main
else
  echo "저장소를 새로 만듭니다: $USER/$REPO"
  "$GH" repo create "$REPO" --public --source=. --remote=origin --push
fi

# 4) GitHub Pages 켜기 (main 브랜치의 /docs 폴더)
echo "Pages 설정 중…"
"$GH" api -X POST "repos/$USER/$REPO/pages" \
  -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1 \
  || "$GH" api -X PUT "repos/$USER/$REPO/pages" \
       -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1 || true

echo ""
echo "════════════════════════════════════════════"
echo " 공개 주소 (1~2분 뒤 열립니다)"
echo "   https://$USER.github.io/$REPO/"
echo "════════════════════════════════════════════"
echo " 폰·태블릿 어디서나 접속됩니다. 로그인 필요 없어요."
