# Agente Nova Raphaella — envia o cadastro e o estoque do Gestao para a nuvem e mantem o "ouvinte" ligado.
# Roda sozinho pelo Agendador de Tarefas do Windows a cada 5 minutos. Quem grava no Gestao e' o ouvinte (ouvinte.ps1),
# e so o que o site mandou pela fila.
$ErrorActionPreference = "Stop"
$Versao = "2.9.8"
$Pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Pasta "agente.log"
$Trava = Join-Path $Pasta "rodando.lock"

function Escreve($t) {
  $linha = (Get-Date -Format "dd/MM/yyyy HH:mm:ss") + "  " + $t
  Add-Content -Path $Log -Value $linha -Encoding UTF8
  Write-Host $linha
}

# Nao deixa duas execucoes ao mesmo tempo
if (Test-Path $Trava) {
  $idade = (Get-Date) - (Get-Item $Trava).LastWriteTime
  if ($idade.TotalMinutes -lt 30) { Write-Host "Ja tem uma execucao em andamento."; exit 0 }
}
Set-Content -Path $Trava -Value (Get-Date)

try {
  # Log nao cresce sem limite
  if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 2MB)) { Move-Item $Log (Join-Path $Pasta "agente_anterior.log") -Force }

  $cfg = Get-Content (Join-Path $Pasta "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  function Envia($acao, $dados) {
    $corpo = @{ token = $cfg.token; acao = $acao; dados = $dados } | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($corpo)
    $resp = Invoke-RestMethod -Uri $cfg.url -Method Post -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 120
    if (-not $resp.ok) { throw "nuvem respondeu: " + ($resp | ConvertTo-Json -Compress) }
    return $resp
  }
  # Envio de JSON montado a mao (mais rapido para milhares de linhas)
  function EnviaBruto($acao, $dadosJson) {
    $corpo = '{"token":"' + $cfg.token + '","acao":"' + $acao + '","dados":' + $dadosJson + '}'
    $bytes = [Text.Encoding]::UTF8.GetBytes($corpo)
    $resp = Invoke-RestMethod -Uri $cfg.url -Method Post -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 120
    if (-not $resp.ok) { throw "nuvem respondeu: " + ($resp | ConvertTo-Json -Compress) }
    return $resp
  }
  function J($s) { # texto -> literal JSON
    if ($null -eq $s) { return "null" }
    $s = [string]$s
    $s = $s.Replace("\", "\\").Replace('"', '\"').Replace("`r", "").Replace("`n", " ").Replace("`t", " ")
    return '"' + $s + '"'
  }
  function N($s) { # numero em texto -> numero JSON (ou null)
    if ([string]::IsNullOrWhiteSpace($s)) { return "null" }
    $v = 0.0
    if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { return $v.ToString([Globalization.CultureInfo]::InvariantCulture) }
    return "null"
  }

  # 0a) Garante que o ouvinte (processo sempre ligado que aplica os pedidos do site) esta rodando
  $arqOuv = Join-Path $Pasta "ouvinte.ps1"; $vivo = Join-Path $Pasta "ouvinte.alive"
  if (Test-Path $arqOuv) {
    $precisa = $true
    if (Test-Path $vivo) { $precisa = (((Get-Date) - (Get-Item $vivo).LastWriteTime).TotalSeconds -gt 90) }
    if ($precisa) {
      Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $arqOuv) -WindowStyle Hidden
      Escreve "Ouvinte iniciado."
    }
  }

  # 0) Publica paginas do sistema deixadas na pasta "publicar" (enviadas pelo Claude para este PC)
  $pastaPub = Join-Path $Pasta "publicar"; $pastaFeito = Join-Path $Pasta "publicados"
  if (Test-Path $pastaPub) {
    if (-not (Test-Path $pastaFeito)) { New-Item -ItemType Directory -Path $pastaFeito | Out-Null }
    foreach ($arq in Get-ChildItem $pastaPub -File) {
      $conteudo = [IO.File]::ReadAllText($arq.FullName, [Text.Encoding]::UTF8)
      $tipo = switch ($arq.Extension.ToLower()) { ".html" { "text/html; charset=utf-8" } ".js" { "text/javascript; charset=utf-8" } ".css" { "text/css; charset=utf-8" } ".json" { "application/json; charset=utf-8" } ".svg" { "image/svg+xml" } default { "text/plain; charset=utf-8" } }
      $r = Envia "publicar_site" @{ nome = $arq.Name; conteudo = $conteudo; tipo = $tipo }
      Move-Item $arq.FullName (Join-Path $pastaFeito ((Get-Date -Format "yyyyMMdd-HHmmss") + "_" + $arq.Name)) -Force
      Escreve ("Publicado: " + $arq.Name + " (" + $conteudo.Length + " caracteres)")
    }
  }

  # 1) Exporta do Gestao com o isql
  $saida = Join-Path $Pasta "exportacao.txt"
  if (Test-Path $saida) { Remove-Item $saida -Force }
  $argsIsql = @("-u", $cfg.usuario, "-p", $cfg.senha, "-i", (Join-Path $Pasta "consulta.sql"), "-o", $saida, $cfg.banco)
  $p = Start-Process -FilePath $cfg.isql -ArgumentList $argsIsql -Wait -PassThru -NoNewWindow -RedirectStandardError (Join-Path $Pasta "isql_erro.txt") -RedirectStandardOutput (Join-Path $Pasta "isql_saida.txt")
  $erroIsql = ""
  if (Test-Path (Join-Path $Pasta "isql_erro.txt")) { $erroIsql = (Get-Content (Join-Path $Pasta "isql_erro.txt") -Raw) }
  if (-not (Test-Path $saida)) { throw "isql nao gerou a exportacao. " + $erroIsql }

  $enc = [Text.Encoding]::GetEncoding(1252)
  $linhas = [IO.File]::ReadAllLines($saida, $enc)
  $produtos = @{}   # id -> linha
  $listas = New-Object Collections.Generic.List[string]
  $auxiliares = New-Object Collections.Generic.List[string]
  $ncmCest = New-Object Collections.Generic.List[string]
  foreach ($l in $linhas) {
    $t = $l.TrimEnd()
    if (-not $t.EndsWith("|#")) { continue }
    $t = $t.Substring(0, $t.Length - 2)
    if ($t.StartsWith("P|")) {
      $id = $t.Substring(2, $t.IndexOf("|", 2) - 2)
      $produtos[$id] = $t
    } elseif ($t.Length -gt 2 -and "GDSF".Contains($t.Substring(0, 1)) -and $t[1] -eq "|") {
      $listas.Add($t)
    } elseif ($t.StartsWith("A|")) {
      $auxiliares.Add($t)
    } elseif ($t.StartsWith("C|")) {
      $ncmCest.Add($t)
    }
  }
  if ($produtos.Count -eq 0) { throw "a exportacao veio vazia. " + $erroIsql }

  # 2) Compara com o que ja foi enviado
  $arqEstado = Join-Path $Pasta "estado.txt"
  $estado = @{}
  if (Test-Path $arqEstado) {
    foreach ($l in [IO.File]::ReadAllLines($arqEstado, [Text.Encoding]::UTF8)) {
      $i = $l.IndexOf("|", 2); if ($i -gt 2) { $estado[$l.Substring(2, $i - 2)] = $l }
    }
  }
  $mudados = New-Object Collections.Generic.List[string]
  foreach ($k in $produtos.Keys) { if (-not $estado.ContainsKey($k) -or $estado[$k] -ne $produtos[$k]) { $mudados.Add($k) } }
  $removidos = New-Object Collections.Generic.List[string]
  foreach ($k in $estado.Keys) { if (-not $produtos.ContainsKey($k)) { $removidos.Add($k) } }

  # 3) Envia em lotes de 500
  $enviados = 0; $lote = New-Object Collections.Generic.List[string]
  function MontaProduto($t) {
    # P|id|ci|ean|desc...|est|pc|pv|cm|g|d|s|f|ncm|at|uap|ua  (descricao pode conter "|": 4 campos da frente, 12 de tras)
    $c = $t.Split("|")
    $n = $c.Length
    $desc = ($c[4..($n - 13)] -join "|")
    return '{"id":' + $c[1] + ',"ci":' + (J $c[2]) + ',"ean":' + (J $c[3]) + ',"desc":' + (J $desc) +
      ',"est":' + (N $c[$n - 12]) + ',"pc":' + (N $c[$n - 11]) + ',"pv":' + (N $c[$n - 10]) + ',"cm":' + (N $c[$n - 9]) +
      ',"g":' + (N $c[$n - 8]) + ',"d":' + (N $c[$n - 7]) + ',"s":' + (N $c[$n - 6]) + ',"f":' + (N $c[$n - 5]) +
      ',"ncm":' + (J $c[$n - 4]) + ',"at":' + (N $c[$n - 3]) + ',"uap":' + (J $c[$n - 2]) + ',"ua":' + (J $c[$n - 1]) + '}'
  }
  function Despacha() {
    if ($script:lote.Count -eq 0) { return }
    $json = "[" + ($script:lote -join ",") + "]"
    $r = EnviaBruto "produtos" $json
    $script:enviados += $script:lote.Count
    $script:lote = New-Object Collections.Generic.List[string]
  }
  foreach ($k in $mudados) {
    $lote.Add((MontaProduto $produtos[$k]))
    if ($lote.Count -ge 500) { Despacha }
  }
  Despacha
  if ($removidos.Count -gt 0) {
    for ($i = 0; $i -lt $removidos.Count; $i += 500) {
      $fim = [Math]::Min($i + 499, $removidos.Count - 1)
      $null = EnviaBruto "remover_produtos" ("[" + (($removidos[$i..$fim] | ForEach-Object { [int]$_ }) -join ",") + "]")
    }
  }

  # 4) Listas (grupos, departamentos, secoes, familias) — pequenas, vao inteiras quando mudam
  $arqListas = Join-Path $Pasta "listas_enviadas.txt"
  $textoListas = ($listas -join "`n")
  $listasAntes = ""
  if (Test-Path $arqListas) { $listasAntes = [IO.File]::ReadAllText($arqListas, [Text.Encoding]::UTF8) }
  $listasEnviadas = 0
  if ($textoListas -ne $listasAntes) {
    $itens = New-Object Collections.Generic.List[string]
    foreach ($t in $listas) {
      $c = $t.Split("|"); $n = $c.Length
      $desc = ($c[2..($n - 2)] -join "|")
      $itens.Add('{"t":' + (J $c[0]) + ',"id":' + (N $c[1]) + ',"desc":' + (J $desc) + ',"pai":' + (N $c[$n - 1]) + '}')
    }
    $null = EnviaBruto "listas" ("[" + ($itens -join ",") + "]")
    [IO.File]::WriteAllText($arqListas, $textoListas, [Text.Encoding]::UTF8)
    $listasEnviadas = $itens.Count
  }

  # 4b) Codigos auxiliares (segundo codigo de barras do mesmo produto) — vao inteiros quando mudam
  $arqAux = Join-Path $Pasta "auxiliares_enviados.txt"
  $textoAux = ($auxiliares -join "`n")
  $auxAntes = ""
  if (Test-Path $arqAux) { $auxAntes = [IO.File]::ReadAllText($arqAux, [Text.Encoding]::UTF8) }
  $auxEnviados = 0
  if ($textoAux -ne $auxAntes) {
    $itens = New-Object Collections.Generic.List[string]
    foreach ($t in $auxiliares) {
      $c = $t.Split("|"); if ($c.Length -lt 3) { continue }
      $itens.Add('{"id":' + (N $c[1]) + ',"ean":' + (J $c[2].Trim()) + '}')
    }
    $null = EnviaBruto "auxiliares" ("[" + ($itens -join ",") + "]")
    [IO.File]::WriteAllText($arqAux, $textoAux, [Text.Encoding]::UTF8)
    $auxEnviados = $itens.Count
  }

  # 4c) Pares NCM -> CEST do cadastro (para sugerir o CEST na entrada manual)
  $arqNc = Join-Path $Pasta "ncm_cest_enviados.txt"
  $textoNc = ($ncmCest -join "`n")
  $ncAntes = ""
  if (Test-Path $arqNc) { $ncAntes = [IO.File]::ReadAllText($arqNc, [Text.Encoding]::UTF8) }
  if ($textoNc -ne $ncAntes) {
    $itens = New-Object Collections.Generic.List[string]
    foreach ($t in $ncmCest) {
      $c = $t.Split("|"); if ($c.Length -lt 4) { continue }
      $itens.Add('{"ncm":' + (J $c[1].Trim()) + ',"cest":' + (J $c[2].Trim()) + ',"qtd":' + (N $c[3]) + '}')
    }
    $null = EnviaBruto "ncm_cest" ("[" + ($itens -join ",") + "]")
    [IO.File]::WriteAllText($arqNc, $textoNc, [Text.Encoding]::UTF8)
  }

  # 5) Guarda o estado enviado e avisa que esta vivo
  if ($mudados.Count -gt 0 -or $removidos.Count -gt 0 -or -not (Test-Path $arqEstado)) {
    [IO.File]::WriteAllLines($arqEstado, [string[]]$produtos.Values, [Text.Encoding]::UTF8)
  }
  $info = @{ versao = $Versao; pc = $env:COMPUTERNAME; produtos = $produtos.Count; enviados = $enviados; removidos = $removidos.Count; listas = $listasEnviadas; auxiliares = $auxiliares.Count; ncm_cest = $ncmCest.Count; quando = (Get-Date).ToString("s") }
  $null = Envia "heartbeat" $info
  Escreve ("OK: " + $produtos.Count + " produtos no Gestao, " + $enviados + " enviados, " + $removidos.Count + " removidos, " + $listasEnviadas + " itens de listas, " + $auxEnviados + " auxiliares enviados.")
  # 5b) Copia de seguranca diaria: baixa da nuvem as notas, boletos e validades (e os arquivos do sistema) para este computador.
  #     Uma vez por dia; guarda os ultimos 60 dias. Qualquer problema aqui nao derruba o agente.
  try {
    $pastaBk = Join-Path $Pasta "backup"
    if (-not (Test-Path $pastaBk)) { New-Item -ItemType Directory -Path $pastaBk | Out-Null }
    $arqBk = Join-Path $pastaBk ("nuvem_" + (Get-Date -Format "yyyy-MM-dd") + ".json")
    if (-not (Test-Path $arqBk)) {
      $corpoBk = [Text.Encoding]::UTF8.GetBytes('{"token":"' + $cfg.token + '","acao":"backup","dados":null}')
      $tmpBk = $arqBk + ".baixando"
      Invoke-WebRequest -Uri $cfg.url -Method Post -Body $corpoBk -ContentType "application/json; charset=utf-8" -TimeoutSec 300 -UseBasicParsing -OutFile $tmpBk
      $tamBk = (Get-Item $tmpBk).Length
      $iniBk = ""
      if ($tamBk -gt 200) { $bytesBk = [IO.File]::ReadAllBytes($tmpBk); $iniBk = [Text.Encoding]::UTF8.GetString($bytesBk, 0, 12); $bytesBk = $null }
      if ($iniBk.StartsWith('{"ok":true')) {
        Move-Item $tmpBk $arqBk -Force
        Escreve ("Copia de seguranca gravada: " + $arqBk + " (" + [Math]::Round($tamBk / 1KB) + " KB)")
        Get-ChildItem $pastaBk -Filter "nuvem_*.json" | Sort-Object Name -Descending | Select-Object -Skip 60 | Remove-Item -Force -ErrorAction SilentlyContinue
      } else {
        Remove-Item $tmpBk -Force -ErrorAction SilentlyContinue
        Escreve "Copia de seguranca: resposta inesperada da nuvem; tenta de novo na proxima rodada."
      }
    }
  } catch { Escreve ("Copia de seguranca nao feita nesta rodada: " + $_.Exception.Message) }

  # 6) Atualizacao automatica: a nuvem informa a versao atual do agente; se for outra, baixa os arquivos, confere e troca.
  #    Qualquer problema aqui nao derruba o agente: ele segue na versao que esta.
  try {
    $at = Envia "atualizacao" @{ versao = $Versao }
    if ($at.versao -and ($at.versao -ne $Versao) -and $at.arquivos) {
      $permitidos = @("agente.ps1", "ouvinte.ps1", "consulta.sql", "pos_envio.ps1")
      $prontos = @(); $tudoOk = $true
      foreach ($a in $at.arquivos) {
        if ($permitidos -notcontains $a.nome) { continue }
        $texto = [string]$a.conteudo
        if ($texto.Length -lt 50) { $tudoOk = $false; Escreve ("Atualizacao: " + $a.nome + " veio vazio."); break }
        $atualArq = Join-Path $Pasta $a.nome
        if ((Test-Path $atualArq) -and ([IO.File]::ReadAllText($atualArq, [Text.Encoding]::UTF8) -ceq $texto)) { continue }  # arquivo igual: nao mexe (nao reinicia o ouvinte a toa)
        $novo = Join-Path $Pasta ($a.nome + ".novo")
        if ($a.nome.EndsWith(".ps1")) {
          if (-not $texto.Contains("FIM-DO-ARQUIVO")) { $tudoOk = $false; Escreve ("Atualizacao: " + $a.nome + " veio incompleto."); break }
          $errosPs = $null
          $null = [System.Management.Automation.PSParser]::Tokenize($texto, [ref]$errosPs)
          if ($errosPs -and $errosPs.Count -gt 0) { $tudoOk = $false; Escreve ("Atualizacao: " + $a.nome + " tem erro de sintaxe; nao foi aplicado."); break }
          [IO.File]::WriteAllText($novo, $texto, (New-Object Text.UTF8Encoding($true)))
        } else {
          [IO.File]::WriteAllText($novo, $texto, [Text.Encoding]::ASCII)
        }
        $prontos += $a.nome
      }
      if ($tudoOk -and $prontos.Count -gt 0) {
        foreach ($n in $prontos) {
          $dest = Join-Path $Pasta $n
          if (Test-Path $dest) { Copy-Item $dest ($dest + ".anterior") -Force }
          Move-Item (Join-Path $Pasta ($n + ".novo")) $dest -Force
        }
        Escreve ("Agente atualizado da versao " + $Versao + " para " + $at.versao + ": " + ($prontos -join ", "))
      } else {
        Get-ChildItem $Pasta -Filter "*.novo" | Remove-Item -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { Escreve ("Atualizacao automatica nao aplicada (segue na versao atual): " + $_.Exception.Message) }
}
catch {
  Escreve ("ERRO: " + $_.Exception.Message)
  try {
    if ($cfg) { $null = Envia "heartbeat" @{ versao = $Versao; pc = $env:COMPUTERNAME; erro = $_.Exception.Message; quando = (Get-Date).ToString("s") } }
  } catch {}
  exit 1
}
finally {
  Remove-Item $Trava -Force -ErrorAction SilentlyContinue
}
# FIM-DO-ARQUIVO
