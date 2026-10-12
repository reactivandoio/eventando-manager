#!/bin/bash
# REA-6: valida a chave do Opa Pingou, cadastra o endpoint de webhook do BFF e grava
# a chave e o whsec_ como secrets no GitHub.
#
# A chave é digitada com entrada oculta. Ela e o whsec_ só passam por variáveis deste
# processo e pelo stdin do curl e do gh: nunca por argumento de comando, arquivo ou saída.
# Bash 3.2 (macOS): sem here-strings, que lá viram arquivo temporário.
#
# Rodar só com ok do Pedro, de uma máquina com gh logado: ./scripts/opapingou-secrets.sh
# Os dois secrets vão para o Environment production; o próximo deploy de cada repositório os
# coloca no .env do servidor.
set -euo pipefail
set +x

API="${OPAPINGOU_API_URL:-https://api.opapingou.com.br}"
WEBHOOK_URL="${OPAPINGOU_WEBHOOK_URL:-https://bff.hubcommunity.io/webhooks/opapingou}"
KEY_REPO="reactivandoio/eventando-manager"
KEY_NAME="OPAPINGOU_API_KEY"
WH_REPO="reactivandoio/hub-community-bff"
WH_NAME="OPAPINGOU_WEBHOOK_SECRET"
EVENTS='["charge.paid","charge.expired","charge.canceled","payment.confirmed","payment.refunded","payment.charged_back"]'

KEY=""
SECRET=""
trap 'KEY=""; SECRET=""' EXIT

for bin in gh jq curl; do
  command -v "$bin" >/dev/null || { echo "Falta $bin no PATH." >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "gh sem login: rode gh auth login." >&2; exit 1; }

# Cabeçalho de autorização pelo stdin do curl (-H @-), nunca na linha de comando.
auth_header() { printf 'Authorization: Bearer %s\n' "$KEY"; }

# call METHOD PATH [JSON]: imprime "<corpo>\n<status http>".
call() {
  if [ $# -ge 3 ]; then
    auth_header | curl -sS -m 30 -X "$1" -H @- -H 'Content-Type: application/json' \
      --data "$3" -w '\n%{http_code}' "$API$2"
  else
    auth_header | curl -sS -m 30 -X "$1" -H @- -w '\n%{http_code}' "$API$2"
  fi
}
status_of() { printf '%s' "$1" | tail -n 1; }
body_of() { printf '%s' "$1" | sed '$d'; }
problem() { body_of "$1" | jq -c '{code, requestId, title}' 2>/dev/null || true; }

IFS= read -rs -p "Chave do Opa Pingou (opk_live_… ou opk_test_…): " KEY
echo
case "$KEY" in
  opk_live_?*|opk_test_?*) ;;
  *) echo "Não parece uma chave opk_live_/opk_test_." >&2; exit 1 ;;
esac

echo "1/4 GET /v1/me"
R=$(call GET /v1/me)
if [ "$(status_of "$R")" != 200 ]; then
  echo "Chave recusada: HTTP $(status_of "$R") $(problem "$R")" >&2; exit 1
fi
echo "Chave válida. Empresa e usuário da chave:"
body_of "$R" | jq '{user: ({id, name, email} | with_entries(select(.value != null))), company}'

echo "2/4 Endpoints já cadastrados"
R=$(call GET /v1/webhook-endpoints)
EXISTING=""
if [ "$(status_of "$R")" = 200 ]; then
  body_of "$R" | jq -r '.items[] | "  \(.id)  \(.status)  \(.url)"'
  EXISTING=$(body_of "$R" | jq -r --arg u "$WEBHOOK_URL" '[.items[] | select(.url == $u)][0].id // empty')
else
  echo "  Sem acesso à lista (HTTP $(status_of "$R") $(problem "$R")); sigo sem ela."
fi

if [ -n "$EXISTING" ]; then
  echo "Já existe um endpoint para $WEBHOOK_URL ($EXISTING): o segredo dele será rotacionado."
else
  echo "Será cadastrado o endpoint $WEBHOOK_URL"
fi
echo "Eventos: $EVENTS"
echo "Secrets (Environment production, que o deploy usa para montar o .env): $KEY_NAME em $KEY_REPO; $WH_NAME em $WH_REPO."
read -r -p "Continuar? [s/N] " OK
[ "$OK" = "s" ] || [ "$OK" = "S" ] || { echo "Nada foi alterado."; exit 0; }

echo "3/4 Chave → $KEY_REPO $KEY_NAME"
printf '%s' "$KEY" | gh secret set "$KEY_NAME" --env production -R "$KEY_REPO"

echo "4/4 Webhook"
if [ -n "$EXISTING" ]; then
  R=$(call POST "/v1/webhook-endpoints/$EXISTING/rotate-secret")
  WANT=200
else
  PAYLOAD=$(jq -nc --arg url "$WEBHOOK_URL" --argjson events "$EVENTS" \
    '{url: $url, description: "Hub Community - inscrições pagas (REA-6)", events: $events}')
  R=$(call POST /v1/webhook-endpoints "$PAYLOAD")
  WANT=201
fi
if [ "$(status_of "$R")" != "$WANT" ]; then
  echo "Falhou: HTTP $(status_of "$R") $(problem "$R")" >&2; exit 1
fi
SECRET=$(body_of "$R" | jq -r '.secret // empty')
case "$SECRET" in
  whsec_?*) ;;
  *) echo "A resposta não trouxe um whsec_. Endpoint: $(body_of "$R" | jq -c 'del(.secret) | {id, url, status}')" >&2
     echo "Recupere com POST /v1/webhook-endpoints/<id>/rotate-secret." >&2; exit 1 ;;
esac
printf '%s' "$SECRET" | gh secret set "$WH_NAME" --env production -R "$WH_REPO"
SECRET=""

echo "Endpoint:"
body_of "$R" | jq 'del(.secret) | {id, url, status, testMode, events}'
echo "Pronto. Secrets gravados:"
gh secret list --env production -R "$KEY_REPO" | grep "^$KEY_NAME" || true
gh secret list --env production -R "$WH_REPO" | grep "^$WH_NAME" || true
