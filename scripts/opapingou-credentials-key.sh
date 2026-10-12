#!/bin/bash
# REA-12: gera a chave mestra que cifra as chaves opk_ e os whsec_ das contas Opa Pingou das
# comunidades e grava como secret OPAPINGOU_CREDENTIALS_KEY no Environment production.
#
# A chave nasce aqui (32 bytes aleatórios) e vai direto para o stdin do gh: nunca para a tela,
# arquivo ou argumento de comando. Não há como lê-la de volta, e não precisa: só o Eventando usa.
#
# Rodar uma vez só, com ok do Pedro, de uma máquina com gh logado:
#   ./scripts/opapingou-credentials-key.sh
# Trocar a chave depois disso torna ilegíveis as contas já conectadas (elas teriam de ser
# conectadas de novo no admin); por isso o script recusa se o secret já existe.
set -euo pipefail
set +x

REPO="reactivandoio/eventando-manager"
NAME="OPAPINGOU_CREDENTIALS_KEY"
ENVIRONMENT="${1:-production}"

for bin in gh openssl; do
  command -v "$bin" >/dev/null || { echo "Falta $bin no PATH." >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "gh sem login: rode gh auth login." >&2; exit 1; }

if gh secret list --env "$ENVIRONMENT" -R "$REPO" --json name -q '.[].name' | grep -qx "$NAME"; then
  echo "$NAME já existe em $REPO ($ENVIRONMENT). Nada foi alterado." >&2
  exit 1
fi

read -r -p "Gerar $NAME e gravar em $REPO ($ENVIRONMENT)? [s/N] " OK
[ "$OK" = "s" ] || [ "$OK" = "S" ] || { echo "Nada foi alterado."; exit 0; }

openssl rand -base64 32 | tr -d '\n' | gh secret set "$NAME" --env "$ENVIRONMENT" -R "$REPO"
echo "Pronto. O próximo deploy coloca $NAME no .env do servidor."
