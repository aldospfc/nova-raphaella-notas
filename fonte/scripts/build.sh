#!/bin/bash
# Monta index.html (raiz do repositório) a partir de fonte/entrada_xml.html, inserindo o supabase-js e a chave pública antes do primeiro <script>.
cd "$(dirname "$0")/../.."
sed 's/\r//' fonte/entrada_xml.html | awk 'BEGIN{f=0} /^<script>/ && f==0 {print "<script src=\"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js\"></script>"; print "<script>window.SUPA={url:\"https://nzecxuuzszkrzukkbaqx.supabase.co\",key:\"sb_publishable_JpyH0LLreCW8yhMVqa7Dig_m6ejXawT\"};</script>"; f=1} {print}' > index.html
grep -c "window.SUPA" index.html
