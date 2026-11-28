# pedido_conferir — e-commerce sem clique (28/11/2026)

Migração `pedido_conferir_despacha_sozinho`. Depois de gravar a conferência, se `p_dados.completo` for verdadeiro, o pedido
já recebe `despachado_em` (com `despachado_por = "<e-mail> (conferência)"`) e a função de borda `bling` o passa para "Atendido".

Não despacha sozinho quando: canal contém "mercado" (o ML avisa a saída; marcar antes viraria "divergente" em 12 h),
conferência com falta, pedido cancelado (`situacao_id = 12`, `ml_status = 'cancelled'`), ignorado ou já despachado.

A mesma regra está em `ckSaiSozinho` na página (só para a mensagem na tela) e nos testes, seção 11.
