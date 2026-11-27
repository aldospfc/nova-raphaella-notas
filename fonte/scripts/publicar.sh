#!/bin/bash
# Publica: monta index.html, faz commit/push e imprime SHA e MD5.
# Depois rode no Supabase (projeto nzecxuuzszkrzukkbaqx): select public.publicar_do_github('<SHA>','<MD5>');
set -e
cd "$(dirname "$0")/../.."
# Regras de ouro (preço sugerido, meia nota, DIFAL, rateio da Loja 2, duas notas): se alguma quebrar, NÃO publica.
[ -d fonte/testes/node_modules/jsdom ] || (cd fonte/testes && npm install --silent --no-audit --no-fund >/dev/null)
if ! node fonte/testes/regras.test.js > /tmp/regras_teste.log 2>&1; then
  grep -E "✘" /tmp/regras_teste.log; tail -1 /tmp/regras_teste.log
  echo "PUBLICAÇÃO CANCELADA: uma regra de ouro quebrou (detalhes acima). Corrija antes de publicar."
  exit 1
fi
echo "Regras de ouro: $(tail -1 /tmp/regras_teste.log)"
bash fonte/scripts/build.sh >/dev/null
git add -A
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -q -m "${1:-Atualização da página}" || echo "(nada mudou)"
git -c push.negotiate=true push -q origin main 2>&1 | grep -v "push negotiation failed" || true
echo "SHA=$(git rev-parse HEAD) MD5=$(md5sum index.html | cut -c1-32)"
