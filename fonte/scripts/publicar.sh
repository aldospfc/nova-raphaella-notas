#!/bin/bash
# Publica: monta index.html, faz commit/push e imprime SHA e MD5.
# Depois rode no Supabase (projeto nzecxuuzszkrzukkbaqx): select public.publicar_do_github('<SHA>','<MD5>');
set -e
cd "$(dirname "$0")/../.."
bash fonte/scripts/build.sh >/dev/null
git add -A
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -q -m "${1:-Atualização da página}" || echo "(nada mudou)"
git -c push.negotiate=true push -q origin main 2>&1 | grep -v "push negotiation failed" || true
echo "SHA=$(git rev-parse HEAD) MD5=$(md5sum index.html | cut -c1-32)"
