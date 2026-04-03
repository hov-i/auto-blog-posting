#!/bin/bash
# Claude Code Stop Hook 설정 스크립트
# 실행: bash setup-hook.sh

SETTINGS_FILE="$HOME/.claude/settings.json"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_CMD="cd $PROJECT_DIR && npm run sync >> $PROJECT_DIR/sync.log 2>&1"

echo "🔧 Claude Code Stop Hook 설정 중..."
echo "📁 프로젝트 경로: $PROJECT_DIR"

# settings.json 없으면 생성
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "{}" > "$SETTINGS_FILE"
fi

# jq로 hook 추가
if ! command -v jq &> /dev/null; then
  echo "❌ jq가 없어요! brew install jq 로 설치해줘~"
  exit 1
fi

UPDATED=$(jq \
  --arg cmd "$HOOK_CMD" \
  '.hooks.Stop = [{"matcher": "", "hooks": [{"type": "command", "command": $cmd}]}]' \
  "$SETTINGS_FILE")

echo "$UPDATED" > "$SETTINGS_FILE"

echo "✅ Stop Hook 설정 완료!"
echo ""
echo "이제 Claude Code 대화가 끝날 때마다 자동으로 sync 실행돼~"
echo "로그 확인: tail -f $PROJECT_DIR/sync.log"
