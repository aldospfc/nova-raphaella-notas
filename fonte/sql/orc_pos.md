# Orçamento no caixa (POS) — peças no banco

- Tabela `orc_pos_arquivos` (loja_id, num 9xxxxxxx, orc_id, conteudo, ativo, valido_ate, gravado_em, reposto, sumiu_em, vendido_em, cupom): orçamentos do sistema que devem estar na pasta `Server_PDV\transf` da loja.
- `orc_pos_sync(p_token, p_tem)`: chamada pelo ouvinte a cada minuto com os arquivos 9xxxxxxx presentes; devolve o que gravar (ativo e ausente) e o que apagar (presente e não ativo/vencido).
- `orc_pos_casar(p_loja)`: o POS apaga o arquivo quando a venda é finalizada; arquivo sumiu + cupom não cancelado da loja nos 10 min anteriores contendo todos os itens (código e quantidade) = marca o orçamento como venda (`docs.dados.status = 'venda'`, `vendaCupom`) e desativa.
- Fila: tipo `orc_pos` (--LISTAR, --LER, --GRAVAR/--COPIAR/--APAGAR só na faixa 9xxxxxxx). `transf` continua sendo a transferência de estoque entre lojas.
