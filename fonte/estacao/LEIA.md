# Estação de etiquetas

PC que só imprime etiquetas (ex.: caixa 2 da Loja 1, `PDV02`, com a Elgin L42 Pro no USB).

- Tabela `estacoes` (token próprio, `papel='etiquetas'`). Quando a estação bate pela primeira vez, fica `ativo=true`.
- Gatilho `fila_rotear`: pedidos `etiqueta`/`impressoras` de uma loja com estação ativa recebem `destino='estacao:N'`;
  o PC principal (`fila_pegar_proximo`/`fila_pendente`) só vê `destino is null`.
- RPCs da estação (chave pública + token): `estacao_bate`, `estacao_pendente`, `estacao_pegar`, `estacao_concluir`,
  `estacao_devolver`, `estacao_programa`. Status para o site: `estacoes_status()`.
- Atualização: gravar o novo `etiquetas.ps1` em `estacao_arquivos` com `versao` igual ao `$Versao` do arquivo.
- Instalação: pasta com `etiquetas.ps1`, `iniciar.vbs`, `instalar.bat`, `desinstalar.bat` e `config.json`
  (`{"url":"https://nzecxuuzszkrzukkbaqx.supabase.co","token":"<token da estação>"}`; o token NÃO vai para o repositório).
  Instala em `%LOCALAPPDATA%\NovaRaphaella\Etiquetas` e cria a tarefa "Nova Raphaella Etiquetas" (a cada 5 min, sem administrador).
- Para voltar a imprimir pelo PC principal: `update estacoes set ativo=false where id=N;` e rodar `desinstalar.bat` na estação.
