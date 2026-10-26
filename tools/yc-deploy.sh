#!/usr/bin/env bash
# Посредник обмена с партнёром в Yandex Cloud: создаёт недостающее и выкладывает код функции.
# Можно запускать сколько угодно раз — существующее не пересоздаётся, обновляется только код.
#
#   tools/yc-deploy.sh
#
# Нужен yc с токеном пользователя (yc config set token …). Всё живёт в отдельном каталоге
# «rashody»: приватный бакет для зашифрованных снимков, сервисный аккаунт с правом только
# на хранилище этого каталога, публичная функция. В конце печатает адрес функции.

set -euo pipefail
YC=${YC:-$HOME/.local/bin/yc}
FOLDER=rashody
SA=rashody-sync
FUNC=rashody-sync
ORIGINS=${ALLOWED_ORIGINS:-https://judaah.github.io}
cd "$(dirname "$0")/.."

say() { printf '\n▸ %s\n' "$*"; }

say "Облако"
# После `yc init` через браузер в профиле нет адреса API — команды serverless без него
# падают с «endpoint should be set» (остальные службы работают и так).
$YC config get endpoint >/dev/null 2>&1 || $YC config set endpoint api.cloud.yandex.net:443
CLOUD_ID=$($YC resource-manager cloud list --format json | jq -r '.[0].id // empty')
[ -n "$CLOUD_ID" ] || { echo "Нет ни одного облака — создай его в console.yandex.cloud"; exit 1; }
$YC config set cloud-id "$CLOUD_ID" >/dev/null
echo "cloud $CLOUD_ID"

say "Каталог $FOLDER"
FOLDER_ID=$($YC resource-manager folder get --name "$FOLDER" --format json 2>/dev/null | jq -r '.id // empty' || true)
[ -n "$FOLDER_ID" ] || FOLDER_ID=$($YC resource-manager folder create --name "$FOLDER" --description "Расходы: посредник обмена с партнёром" --format json | jq -r .id)
echo "folder $FOLDER_ID"

say "Бакет для зашифрованных снимков"
BUCKET="rashody-sync-$FOLDER_ID"
if ! $YC storage bucket get --name "$BUCKET" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  # 1 ГБ потолок: снимки весят килобайты, лимит — защита от неожиданного счёта
  $YC storage bucket create --name "$BUCKET" --folder-id "$FOLDER_ID" --default-storage-class standard --max-size 1073741824 >/dev/null
fi
echo "bucket $BUCKET (приватный)"

say "Сервисный аккаунт функции"
SA_ID=$($YC iam service-account get --name "$SA" --folder-id "$FOLDER_ID" --format json 2>/dev/null | jq -r '.id // empty' || true)
[ -n "$SA_ID" ] || SA_ID=$($YC iam service-account create --name "$SA" --folder-id "$FOLDER_ID" --format json | jq -r .id)
# storage.editor только на этот каталог — других бакетов в нём нет
$YC resource-manager folder add-access-binding --id "$FOLDER_ID" --role storage.editor --service-account-id "$SA_ID" >/dev/null 2>&1 || true
echo "service account $SA_ID (storage.editor на каталог $FOLDER)"

say "Функция"
FUNC_ID=$($YC serverless function get --name "$FUNC" --folder-id "$FOLDER_ID" --format json 2>/dev/null | jq -r '.id // empty' || true)
[ -n "$FUNC_ID" ] || FUNC_ID=$($YC serverless function create --name "$FUNC" --folder-id "$FOLDER_ID" --format json | jq -r .id)
$YC serverless function allow-unauthenticated-invoke --id "$FUNC_ID" >/dev/null
echo "function $FUNC_ID (вызывается без ключа — доступ к паре проверяет сама функция)"

say "Код функции"
npm run --silent build:sync
ZIP=sync-server/dist/function.zip
rm -f "$ZIP"
(cd sync-server/dist && zip -q function.zip index.js package.json)
$YC serverless function version create \
  --function-id "$FUNC_ID" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 128m \
  --execution-timeout 10s \
  --service-account-id "$SA_ID" \
  --environment "BUCKET=$BUCKET,ALLOWED_ORIGINS=$ORIGINS" \
  --source-path "$ZIP" >/dev/null
echo "версия выложена"

URL="https://functions.yandexcloud.net/$FUNC_ID"
say "Готово: $URL"
echo "$URL" > sync-server/dist/url.txt
