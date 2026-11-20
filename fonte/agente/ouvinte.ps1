# Ouvinte Nova Raphaella — fica ligado o tempo todo esperando pedidos do site ("Enviar ao Gestao").
# Quando chega um pedido, grava no Gestao pelo isql e avisa a nuvem; em seguida roda o agente para subir o estoque novo.
# E' iniciado pelo proprio agente (a cada 5 min ele confere se o ouvinte esta vivo). Nao precisa de tarefa propria.
$ErrorActionPreference = "Stop"
$Versao = "2.8.1"
$Pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Pasta "ouvinte.log"
$Vivo = Join-Path $Pasta "ouvinte.alive"
$Parar = Join-Path $Pasta "ouvinte.parar"
$Eu = $MyInvocation.MyCommand.Path
$MeuCarimbo = (Get-Item $Eu).LastWriteTime

function Escreve($t) {
  $linha = (Get-Date -Format "dd/MM/yyyy HH:mm:ss") + "  " + $t
  Add-Content -Path $Log -Value $linha -Encoding UTF8
  Write-Host $linha
}

# So um ouvinte por vez: se o arquivo "alive" foi tocado ha menos de 40 s, ja tem outro rodando
if (Test-Path $Vivo) {
  $idade = (Get-Date) - (Get-Item $Vivo).LastWriteTime
  if ($idade.TotalSeconds -lt 40) { Write-Host "Ja tem um ouvinte rodando."; exit 0 }
}
Set-Content -Path $Vivo -Value $PID
if (Test-Path $Parar) { Remove-Item $Parar -Force }

$cfg = Get-Content (Join-Path $Pasta "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = $cfg.url -replace "/functions/v1/.*$", ""
$chave = if ($cfg.chave) { $cfg.chave } else { "sb_publishable_JpyH0LLreCW8yhMVqa7Dig_m6ejXawT" }
$cab = @{ "apikey" = $chave; "Authorization" = "Bearer " + $chave }

function Rpc($nome, $corpo) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Compress))
  return Invoke-RestMethod -Uri ($base + "/rest/v1/rpc/" + $nome) -Method Post -Headers $cab -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 30
}
function Funcao($acao, $dados) {
  $corpo = @{ token = $cfg.token; acao = $acao; dados = $dados } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($corpo)
  $resp = Invoke-RestMethod -Uri $cfg.url -Method Post -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 120
  if (-not $resp.ok) { throw "nuvem respondeu: " + ($resp | ConvertTo-Json -Compress) }
  return $resp
}

# Programa que atualiza o arquivo dos caixas (roda em PowerShell de 32 bits). Fica embutido aqui para vir junto na atualizacao automatica.
$ProgPos = @'
# Envio ao POS - Nova Raphaella. Atualiza preco/custo/descricao de produtos que JA existem no arquivo dos caixas
# e entrega uma copia para cada caixa, do mesmo jeito que a Carga Completa do Gestao faz. Nao mexe no Gestao.
# Precisa rodar no PowerShell de 32 bits (a sqlite3.dll do Servidor PDV e de 32 bits).
param([string]$Arq, [string]$Saida, [string]$PastaPos = "")
$ErrorActionPreference = "Stop"
$linhas = New-Object System.Collections.ArrayList
function Diz($t) { [void]$linhas.Add([string]$t) }
$novo = $null; $db = [IntPtr]::Zero
try {
  if (-not $PastaPos) { $PastaPos = "C:\Server_PDV\enviar\tabela" }
  $pasta = $PastaPos.TrimEnd("\")
  $banco = Join-Path $pasta "pdv_cad.s3db"
  $versao = Join-Path $pasta "versao_cad_prod.txt"
  if (-not (Test-Path $banco)) { throw ("nao achei o arquivo dos caixas em " + $banco) }
  $raiz = Split-Path -Parent (Split-Path -Parent $pasta)
  $dll = Join-Path $raiz "sqlite3.dll"
  if (-not (Test-Path $dll)) { $dll = "C:\POS\sqlite3.dll" }
  if (-not (Test-Path $dll)) { throw "nao achei a sqlite3.dll do Servidor PDV" }
  $itens = Get-Content $Arq -Raw -Encoding UTF8 | ConvertFrom-Json
  $itens = @($itens)
  if ($itens.Count -eq 0) { throw "nenhum produto no pedido" }

  # se o Gestao estiver gerando uma carga agora, espera ele terminar
  $jr = $banco + "-journal"
  for ($i = 0; $i -lt 45 -and (Test-Path $jr); $i++) { Start-Sleep -Seconds 2 }
  if (Test-Path $jr) { throw "o Gestao esta gerando uma carga neste momento; tente de novo em um minuto" }

  # copia de seguranca: a primeira de cada dia, guarda 7 dias
  $pastaBk = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "backup"
  if (-not (Test-Path $pastaBk)) { New-Item -ItemType Directory -Path $pastaBk | Out-Null }
  $bkDia = Join-Path $pastaBk ("pdv_cad_" + (Get-Date -Format "yyyy-MM-dd") + ".s3db")
  if (-not (Test-Path $bkDia)) { Copy-Item $banco $bkDia -Force }
  Get-ChildItem $pastaBk -Filter "pdv_cad_20*.s3db" | Sort-Object Name -Descending | Select-Object -Skip 7 | Remove-Item -Force -ErrorAction SilentlyContinue

  $fonte = @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class SqNR {
  const string D = @"CAMINHO_DLL";
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_open(byte[] f, out IntPtr db);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_close(IntPtr db);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr cb, IntPtr arg, IntPtr err);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_changes(IntPtr db);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_errmsg(IntPtr db);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_busy_timeout(IntPtr db, int ms);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_step(IntPtr st);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_column_text(IntPtr st, int i);
  [DllImport(D, CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_finalize(IntPtr st);
  public static byte[] Z(string s) { byte[] b = Encoding.UTF8.GetBytes(s); byte[] r = new byte[b.Length + 1]; Array.Copy(b, r, b.Length); return r; }
  public static string Erro(IntPtr db) { return Marshal.PtrToStringAnsi(sqlite3_errmsg(db)); }
  public static void Exec(IntPtr db, string sql) { int rc = sqlite3_exec(db, Z(sql), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero); if (rc != 0) throw new Exception("sqlite (" + rc + "): " + Erro(db)); }
  public static string Um(IntPtr db, string sql) { IntPtr st; int rc = sqlite3_prepare_v2(db, Z(sql), -1, out st, IntPtr.Zero); if (rc != 0) throw new Exception("sqlite (" + rc + "): " + Erro(db)); string v = null; if (sqlite3_step(st) == 100) { IntPtr p = sqlite3_column_text(st, 0); if (p != IntPtr.Zero) v = Marshal.PtrToStringAnsi(p); } sqlite3_finalize(st); return v; }
  public static string Lista(IntPtr db, string sql) { IntPtr st; int rc = sqlite3_prepare_v2(db, Z(sql), -1, out st, IntPtr.Zero); if (rc != 0) throw new Exception("sqlite (" + rc + "): " + Erro(db)); StringBuilder sb = new StringBuilder(); while (sqlite3_step(st) == 100) { IntPtr p = sqlite3_column_text(st, 0); if (p != IntPtr.Zero) { if (sb.Length > 0) sb.Append(";"); sb.Append(Marshal.PtrToStringAnsi(p)); } } sqlite3_finalize(st); return sb.ToString(); }
}
"@
  Add-Type -TypeDefinition ($fonte.Replace("CAMINHO_DLL", $dll))

  # quais caixas existem: cadastro do Servidor PDV; se nao der, os que ja confirmaram carga alguma vez
  $caixas = @()
  $cfgSrv = Join-Path $raiz "cfgServer.s3db"
  if (Test-Path $cfgSrv) {
    try {
      $d2 = [IntPtr]::Zero
      if ([SqNR]::sqlite3_open([SqNR]::Z($cfgSrv), [ref]$d2) -eq 0) {
        $l = [SqNR]::Lista($d2, "SELECT numero FROM pdvs ORDER BY numero")
        [void][SqNR]::sqlite3_close($d2)
        if ($l) { $caixas = @($l.Split(";") | ForEach-Object { ([int]$_).ToString("000") }) }
      }
    } catch { $caixas = @() }
  }
  if ($caixas.Count -eq 0) { $caixas = @(Get-ChildItem $pasta -Filter "sts_cad.*" | ForEach-Object { $_.Extension.TrimStart(".") } | Where-Object { $_ -match "^\d{3}$" }) }
  if ($caixas.Count -eq 0) { throw "nao descobri quais caixas existem nesta loja" }

  $novo = Join-Path $pasta "pdv_cad_nr.tmp"
  Copy-Item $banco $novo -Force
  $rc = [SqNR]::sqlite3_open([SqNR]::Z($novo), [ref]$db)
  if ($rc -ne 0) { throw ("nao abriu o arquivo dos caixas (codigo " + $rc + ")") }
  [void][SqNR]::sqlite3_busy_timeout($db, 15000)
  $totalAntes = [SqNR]::Um($db, "SELECT COUNT(*) FROM produtos")
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $feitos = 0; $fora = New-Object System.Collections.ArrayList
  [SqNR]::Exec($db, "BEGIN IMMEDIATE")
  foreach ($it in $itens) {
    $ean = [string]$it.e
    if ($ean -notmatch "^\d{1,20}$") { continue }
    $sets = @()
    if ($it.v -ne $null -and [double]$it.v -gt 0) { $sets += "rPreco_Venda1 = " + ([double]$it.v).ToString("0.####", $inv) }
    if ($it.c -ne $null -and [double]$it.c -gt 0) { $sets += "rPreco_Compra = " + ([double]$it.c).ToString("0.####", $inv) }
    if ($it.d) {
      $d = ([string]$it.d) -replace "[^\x20-\x7e]", " "
      $d = $d.Trim(); if ($d.Length -gt 60) { $d = $d.Substring(0, 60) }
      if ($d.Length -gt 0) {
        $dp = $d; if ($dp.Length -gt 30) { $dp = $dp.Substring(0, 30) }
        $sets += "sDescricao = '" + $d.Replace("'", "''") + "'"
        $sets += "sDescrPDV = '" + $dp.Replace("'", "''") + "'"
      }
    }
    if ($sets.Count -eq 0) { continue }
    [SqNR]::Exec($db, "UPDATE produtos SET " + ($sets -join ", ") + " WHERE sCodBarras = '" + $ean + "'")
    if ([SqNR]::sqlite3_changes($db) -ge 1) { $feitos++ } else { [void]$fora.Add($ean) }
  }
  $agora = Get-Date
  $carimbo = $agora.ToString("dd/MM/yy-HH:mm:ss")
  if ($feitos -gt 0) { [SqNR]::Exec($db, "UPDATE VersaoBanco SET sDataHoraGerado = '" + $carimbo + "'") }
  [SqNR]::Exec($db, "COMMIT")
  $totalDepois = [SqNR]::Um($db, "SELECT COUNT(*) FROM produtos")
  $confere = [SqNR]::Um($db, "PRAGMA quick_check")
  [void][SqNR]::sqlite3_close($db); $db = [IntPtr]::Zero

  if ($feitos -eq 0) {
    Remove-Item $novo -Force; $novo = $null
    Diz ("POS AVISO: nenhum dos " + $itens.Count + " produto(s) deste envio existe ainda no arquivo dos caixas. Produto novo so entra no caixa com a Carga Completa do Gestao.")
  } else {
    if ($totalAntes -ne $totalDepois -or $confere -ne "ok") { throw ("conferencia do arquivo falhou (" + $totalAntes + " -> " + $totalDepois + ", " + $confere + "); nada foi enviado aos caixas") }
    $ansi = [Text.Encoding]::Default
    $antes = @{}
    foreach ($cx in $caixas) { $f = Join-Path $pasta ("sts_cad." + $cx); if (Test-Path $f) { $antes[$cx] = ([IO.File]::ReadAllText($f)).Trim() } else { $antes[$cx] = "" } }
    # mesma sequencia do Gestao: versao, arquivo novo (o anterior vira _backup), uma copia por caixa, PcCarga e sPathErp
    [IO.File]::WriteAllText($versao, $carimbo + "`r`n", [Text.Encoding]::ASCII)
    $bk = $banco + "_backup"
    if (Test-Path $bk) { Remove-Item $bk -Force }
    Rename-Item $banco ([IO.Path]::GetFileName($bk))
    try { Rename-Item $novo ([IO.Path]::GetFileName($banco)) } catch { Rename-Item $bk ([IO.Path]::GetFileName($banco)); throw }
    $novo = $null
    foreach ($cx in $caixas) {
      $alvo = Join-Path $pasta ("pdv_cad_" + $cx + ".s3db")
      $prov = $alvo + ".nr"
      Copy-Item $banco $prov -Force
      if (Test-Path $alvo) { Remove-Item $alvo -Force }
      Rename-Item $prov ([IO.Path]::GetFileName($alvo))
    }
    try {
      $pc = Join-Path $pasta "PcCarga.txt"
      if (Test-Path $pc) {
        $t = [IO.File]::ReadAllText($pc, $ansi)
        $t = [regex]::Replace($t, "(?m)^Data: .*?(\r?)$", ("Data: " + $agora.ToString("dd/MM/yyyy HH:mm") + '$1'))
        [IO.File]::WriteAllText($pc, $t, $ansi)
      }
      $pe = Join-Path $raiz "sPathErp.dat"
      if (Test-Path $pe) {
        $p = ([IO.File]::ReadAllText($pe, $ansi)).TrimEnd().Split(";")
        if ($p.Length -ge 6) { $p[1] = $agora.ToString("dd/MM/yy"); $p[2] = $agora.ToString("HH:mm"); [IO.File]::WriteAllText($pe, ($p -join ";") + "`r`n", $ansi) }
      }
    } catch {}
    # espera os caixas confirmarem (ate 40 s); caixa desligado ou ocupado carrega depois, sozinho
    $ok = @{}
    for ($i = 0; $i -lt 20 -and $ok.Count -lt $caixas.Count; $i++) {
      Start-Sleep -Seconds 2
      foreach ($cx in $caixas) {
        if ($ok.ContainsKey($cx)) { continue }
        $f = Join-Path $pasta ("sts_cad." + $cx)
        try { if ((Test-Path $f) -and (([IO.File]::ReadAllText($f)).Trim() -ne $antes[$cx])) { $ok[$cx] = (($i + 1) * 2) } } catch {}
      }
    }
    $partes = @()
    foreach ($cx in $caixas) { if ($ok.ContainsKey($cx)) { $partes += ("caixa " + $cx + " carregou em " + $ok[$cx] + " s") } else { $partes += ("caixa " + $cx + " ainda nao confirmou (carrega sozinho quando estiver ligado e livre)") } }
    Diz ("POS OK: " + $feitos + " produto(s) enviados aos caixas - " + ($partes -join "; ") + ".")
    if ($fora.Count -gt 0) { Diz ("POS AVISO: " + $fora.Count + " produto(s) novo(s) ficaram de fora do caixa (so entram com a Carga Completa do Gestao): " + (($fora | Select-Object -First 15) -join ", ")) }
  }
} catch {
  Diz ("POS ERRO: " + $_.Exception.Message)
  try { if ($db -ne [IntPtr]::Zero) { [void][SqNR]::sqlite3_close($db) } } catch {}
  try { if ($novo -and (Test-Path $novo)) { Remove-Item $novo -Force } } catch {}
}
$texto = ($linhas -join "`r`n")
if ($Saida) { [IO.File]::WriteAllText($Saida, $texto, [Text.Encoding]::UTF8) }
Write-Host $texto
# FIM-DO-ARQUIVO-POS
'@
function EnviaPos($id, $pos) {
  $prog = Join-Path $Pasta "pos_envio.ps1"
  $atual = ""
  if (Test-Path $prog) { $atual = [IO.File]::ReadAllText($prog, [Text.Encoding]::UTF8) }
  if ($atual -cne $ProgPos) { [IO.File]::WriteAllText($prog, $ProgPos, (New-Object Text.UTF8Encoding($true))) }
  $arqJ = Join-Path $Pasta ("fila_" + $id + "_pos.json")
  $arqS = Join-Path $Pasta ("fila_" + $id + "_pos.txt")
  [IO.File]::WriteAllText($arqJ, "[" + ($pos -join ",") + "]", (New-Object Text.UTF8Encoding($false)))
  if (Test-Path $arqS) { Remove-Item $arqS -Force }
  $ps32 = Join-Path $env:SystemRoot "SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path $ps32)) { $ps32 = "powershell.exe" }
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $prog + '"'), "-Arq", ('"' + $arqJ + '"'), "-Saida", ('"' + $arqS + '"'))
  if ($cfg.pos_pasta) { $a += @("-PastaPos", ('"' + $cfg.pos_pasta + '"')) }
  $p = Start-Process -FilePath $ps32 -ArgumentList $a -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch {}; return "POS ERRO: o envio aos caixas demorou demais e foi interrompido." }
  if (Test-Path $arqS) { return [IO.File]::ReadAllText($arqS, [Text.Encoding]::UTF8).Trim() }
  return "POS ERRO: o programa de envio aos caixas nao respondeu."
}

# Caixa que estava ocupado (tela de pesquisa, venda aberta) pega o arquivo da carga mas nao importa, e a carga se perde.
# De minuto em minuto confere: se a versao dos produtos e mais nova que a ultima carga confirmada pelo caixa e a copia dele
# ja sumiu da pasta, entrega a copia de novo (ate 10 vezes por versao). Vale tambem para a Carga Completa feita pelo Gestao.
$PosTent = @{}
function ReentregaPos {
  $pasta = "C:\Server_PDV\enviar\tabela"
  if ($cfg.pos_pasta) { $pasta = ([string]$cfg.pos_pasta).TrimEnd("\") }
  $banco = Join-Path $pasta "pdv_cad.s3db"
  $arqV = Join-Path $pasta "versao_cad_prod.txt"
  if (-not (Test-Path $banco) -or -not (Test-Path $arqV)) { return }
  if (Test-Path ($banco + "-journal")) { return }
  $v = ([IO.File]::ReadAllText($arqV)).Trim()
  $dv = [datetime]::ParseExact($v, "dd/MM/yy-HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
  if (((Get-Date) - $dv).TotalSeconds -lt 120) { return }
  $mv = (Get-Item $arqV).LastWriteTime
  foreach ($f in (Get-ChildItem $pasta -Filter "sts_cad.*")) {
    $cx = $f.Extension.TrimStart(".")
    if ($cx -notmatch "^\d{3}$") { continue }
    if ($f.LastWriteTime -ge $mv) { continue }
    $s = ([IO.File]::ReadAllText($f.FullName)).Trim().TrimEnd(";")
    $ds = [datetime]::MinValue
    try { $ds = [datetime]::ParseExact($s, "dd/MM/yy;HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture) } catch {}
    if ($ds -ge $dv) { continue }
    $alvo = Join-Path $pasta ("pdv_cad_" + $cx + ".s3db")
    if (Test-Path $alvo) { continue }
    $k = $cx + "|" + $v
    if (-not $PosTent.ContainsKey($k)) { $PosTent[$k] = @{ n = 0; t = (Get-Date "2000-01-01") } }
    $e = $PosTent[$k]
    if ($e.n -ge 10 -or ((Get-Date) - $e.t).TotalSeconds -lt 110) { continue }
    $prov = $alvo + ".nr"
    Copy-Item $banco $prov -Force
    Rename-Item $prov ([IO.Path]::GetFileName($alvo))
    $e.n++; $e.t = Get-Date
    Escreve ("POS: caixa " + $cx + " nao tinha carregado a versao " + $v + "; entreguei de novo (tentativa " + $e.n + ").")
  }
}

# Vendas: de 5 em 5 minutos le do Gestao os totais por hora e por forma de pagamento e manda para a nuvem (so leitura no Gestao).
# Na primeira vez manda o historico inteiro; depois, so os ultimos 5 dias (que substituem o que a nuvem tinha desses dias).
function RpcBruto($nome, $json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri ($base + "/rest/v1/rpc/" + $nome) -Method Post -Headers $cab -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 120
}
function SobeVendas {
  $marc = Join-Path $Pasta "vendas_inicial.ok"
  $inicial = -not (Test-Path $marc)
  $desde = (Get-Date).AddDays(-5).ToString("yyyy-MM-dd")
  if ($inicial) { $desde = "2018-01-01" }
  $arq = Join-Path $Pasta "vendas.sql"
  $saida = Join-Path $Pasta "vendas_saida.txt"
  $erro = Join-Path $Pasta "vendas_erro.txt"
  $sql = @(
    ("SELECT 'VH|' || CAST(DATA AS VARCHAR(10)) || '|' || CAST(I_HORA AS VARCHAR(6)) || '|' || CAST(PDV AS VARCHAR(6)) || '|' || COALESCE(S_OPERACAO, 'V') || '|' || CAST(SUM(QTD) AS VARCHAR(30)) || '|' || CAST(SUM(VALOR) AS VARCHAR(30)) FROM VENDAS_HORA WHERE DATA >= CAST('" + $desde + "' AS DATE) AND DATA <= CURRENT_DATE + 1 AND I_HORA IS NOT NULL AND PDV IS NOT NULL GROUP BY DATA, I_HORA, PDV, S_OPERACAO;"),
    ("SELECT 'PG|' || CAST(D_DATA AS VARCHAR(10)) || '|' || CAST(ID_PDV AS VARCHAR(6)) || '|' || CAST(ID_MEIO_PAGAMENTO AS VARCHAR(6)) || '|' || CAST(COALESCE(I_TIPO, 1) AS VARCHAR(6)) || '|' || CAST(SUM(I_QUANTIDADE) AS VARCHAR(30)) || '|' || CAST(SUM(F_VALOR) AS VARCHAR(30)) FROM PAGAMENTOS_PDV WHERE D_DATA >= CAST('" + $desde + "' AS DATE) AND D_DATA <= CURRENT_DATE + 1 AND ID_PDV IS NOT NULL AND ID_MEIO_PAGAMENTO IS NOT NULL GROUP BY D_DATA, ID_PDV, ID_MEIO_PAGAMENTO, I_TIPO;"),
    "")
  [IO.File]::WriteAllText($arq, ($sql -join "`r`n"), [Text.Encoding]::ASCII)
  foreach ($f in @($saida, $erro)) { if (Test-Path $f) { Remove-Item $f -Force } }
  $argsIsql = @("-u", $cfg.usuario, "-p", $cfg.senha, "-i", $arq, "-o", $saida, $cfg.banco)
  $p = Start-Process -FilePath $cfg.isql -ArgumentList $argsIsql -Wait -PassThru -NoNewWindow -RedirectStandardError $erro
  if (-not (Test-Path $saida)) { throw "o isql nao respondeu a consulta de vendas" }
  $txt = [IO.File]::ReadAllText($saida, [Text.Encoding]::ASCII)
  if ($txt -match "Statement failed") { throw ("consulta de vendas recusada: " + (($txt -replace "\s+", " ").Substring(0, [Math]::Min(200, ($txt -replace "\s+", " ").Length)))) }
  $vh = New-Object System.Collections.ArrayList; $pg = New-Object System.Collections.ArrayList
  $num = "^-?\d+(\.\d+)?$"
  foreach ($ln in ($txt -split "\r?\n")) {
    $l = $ln.Trim()
    if ($l.Length -lt 10) { continue }
    $c = $l.Split("|")
    if ($c.Length -ne 7) { continue }
    for ($i = 1; $i -lt 7; $i++) { $c[$i] = $c[$i].Trim() }
    if ($c[1] -notmatch "^\d{4}-\d{2}-\d{2}$") { continue }
    if ($c[0] -eq "VH") {
      if ($c[2] -notmatch "^\d+$" -or $c[3] -notmatch "^\d+$" -or $c[5] -notmatch $num -or $c[6] -notmatch $num) { continue }
      $op = ($c[4] -replace "[^A-Za-z0-9]", ""); if (-not $op) { $op = "V" }
      [void]$vh.Add('["' + $c[1] + '",' + $c[2] + ',' + $c[3] + ',"' + $op + '",' + $c[5] + ',' + $c[6] + ']')
    } elseif ($c[0] -eq "PG") {
      if ($c[2] -notmatch "^\d+$" -or $c[3] -notmatch "^\d+$" -or $c[4] -notmatch "^-?\d+$" -or $c[5] -notmatch "^-?\d+$" -or $c[6] -notmatch $num) { continue }
      [void]$pg.Add('["' + $c[1] + '",' + $c[2] + ',' + $c[3] + ',' + $c[4] + ',' + $c[5] + ',' + $c[6] + ']')
    }
  }
  $tk = ($cfg.token | ConvertTo-Json)
  if (-not $inicial) {
    $r = RpcBruto "vendas_subir" ('{"p_token":' + $tk + ',"p_vh":[' + ($vh -join ",") + '],"p_pg":[' + ($pg -join ",") + '],"p_desde":"' + $desde + '"}')
    if (-not $r.ok) { throw "a nuvem recusou as vendas" }
    return
  }
  for ($i = 0; $i -lt $vh.Count; $i += 2000) {
    $parte = $vh.GetRange($i, [Math]::Min(2000, $vh.Count - $i))
    $r = RpcBruto "vendas_subir" ('{"p_token":' + $tk + ',"p_vh":[' + ($parte -join ",") + '],"p_pg":[]}')
    if (-not $r.ok) { throw "a nuvem recusou o historico de vendas" }
  }
  for ($i = 0; $i -lt $pg.Count; $i += 2000) {
    $parte = $pg.GetRange($i, [Math]::Min(2000, $pg.Count - $i))
    $r = RpcBruto "vendas_subir" ('{"p_token":' + $tk + ',"p_vh":[],"p_pg":[' + ($parte -join ",") + ']}')
    if (-not $r.ok) { throw "a nuvem recusou o historico de pagamentos" }
  }
  Set-Content -Path $marc -Value (Get-Date)
  Escreve ("Vendas: historico enviado (" + $vh.Count + " linhas por hora, " + $pg.Count + " de pagamentos).")
}

# Cupons: o Servidor PDV guarda um arquivo pequeno por cupom (BkLog_PDV\<Mes_Ano>\<caixa>\lg_*.mzip). De 5 em 5 minutos
# le os arquivos novos (so leitura) e manda para a nuvem: data, hora, caixa, itens, formas de pagamento e NFC-e.
# Na primeira vez pega os ultimos 3 meses, aos poucos (1500 arquivos por vez) para nao segurar os envios do site.
$EncCup = [Text.Encoding]::GetEncoding(1252)
function LeMzip($caminho) {
  $b = [IO.File]::ReadAllBytes($caminho)
  for ($i = 40; $i -lt ($b.Length - 2); $i++) {
    if ($b[$i] -ne 0x78 -or $b[$i + 1] -ne 0x9C) { continue }
    try {
      $ms = New-Object IO.MemoryStream -ArgumentList (, $b)
      $ms.Position = $i + 2
      $ds = New-Object IO.Compression.DeflateStream -ArgumentList $ms, ([IO.Compression.CompressionMode]::Decompress)
      $sai = New-Object IO.MemoryStream
      $buf = New-Object byte[] 8192
      while ($true) { $n = $ds.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $sai.Write($buf, 0, $n) }
      $t = $EncCup.GetString($sai.ToArray())
      if ($t.StartsWith("R00|")) { return $t }
    } catch {}
  }
  return $null
}
function NumCup($s) { $x = ([string]$s).Trim().Replace(",", "."); if ($x -match "^-?\d+(\.\d+)?$") { return ([decimal]::Parse($x, [Globalization.CultureInfo]::InvariantCulture)).ToString([Globalization.CultureInfo]::InvariantCulture) }; return "0" }
function JsCup($s) { $x = (([string]$s) -replace '[\x00-\x1f]', ' ').Trim(); $x = $x.Replace('\', '\\').Replace('"', '\"'); return ('"' + $x + '"') }
function MontaCupom($txt, $arquivo) {
  $r00 = $null; $r04 = $null; $nfcN = ""; $nfcK = ""
  $itens = New-Object System.Collections.ArrayList; $pg = New-Object System.Collections.ArrayList
  foreach ($ln in ($txt -split "\r?\n")) {
    $c = $ln.Split("|")
    if ($c[0] -eq "R00") { $r00 = $c }
    elseif ($c[0] -eq "R04") { if (-not $r04) { $r04 = $c } }
    elseif ($c[0] -eq "R05") { if ($c.Length -gt 30) { [void]$itens.Add("[" + (NumCup $c[4]) + "," + (JsCup $c[5]) + "," + (JsCup $c[6]) + "," + (NumCup $c[7]) + "," + (JsCup $c[8]) + "," + (NumCup $c[9]) + "," + (NumCup $c[12]) + "," + (NumCup $c[30]) + "," + (JsCup $c[14]) + "]") } }
    elseif ($c[0] -eq "R07") { if ($c.Length -gt 7) { [void]$pg.Add("[" + (NumCup $c[5]) + "," + (JsCup $c[6]) + "," + (NumCup $c[7]) + "]") } }
    elseif ($c[0] -eq "NFC") { if ($c.Length -gt 4) { $nfcN = $c[2]; $nfcK = $c[4] } }
  }
  if (-not $r00 -or -not $r04) { return $null }
  if ($r00.Length -lt 12 -or $r04.Length -lt 15) { return $null }
  $tipo = $r00[1]
  if (@("01", "02", "03") -notcontains $tipo) { return $null }
  if ($r04[5] -notmatch "^(\d\d)/(\d\d)/(\d\d)$") { return $null }
  $d = "20" + $Matches[3] + "-" + $Matches[2] + "-" + $Matches[1]
  $coo = $r04[3].Trim()
  if (-not $coo) { return $null }
  $canc = "false"; if ($tipo -ne "01" -or $r04[14] -eq "S") { $canc = "true" }
  $pdv = "null"; if ($r00[6] -match "^\d+$") { $pdv = [string][int]$r00[6] }
  $hora = ""; if ($r04[6] -match "^\d\d:\d\d:\d\d$") { $hora = $r04[6] }
  return ('{"s":' + (JsCup $r04[1]) + ',"c":' + (JsCup $coo) + ',"d":"' + $d + '","h":"' + $hora + '","p":' + $pdv + ',"f":' + (JsCup $r04[4]) + ',"t":' + (NumCup $r04[13]) + ',"x":' + $canc + ',"o":' + (JsCup $r00[11]) + ',"n":' + (JsCup $nfcN) + ',"k":' + (JsCup $nfcK) + ',"i":[' + ($itens -join ",") + '],"g":[' + ($pg -join ",") + '],"a":' + (JsCup $arquivo) + '}')
}
function SobeCupons {
  $raizBk = "C:\Server_PDV\BkLog_PDV"
  if ($cfg.pos_pasta) { $raizBk = Join-Path (Split-Path -Parent (Split-Path -Parent (([string]$cfg.pos_pasta).TrimEnd("\")))) "BkLog_PDV" }
  if (-not (Test-Path $raizBk)) { return $false }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $arqEst = Join-Path $Pasta "cupons_estado.txt"
  # a versao 2.6 pulou o fim de outubro ao trocar de mes; uma unica vez, recomeca a leitura dos 3 meses (regravar e inofensivo)
  $marcRef = Join-Path $Pasta "cupons_refeito_27.ok"
  if (-not (Test-Path $marcRef)) { if (Test-Path $arqEst) { Remove-Item $arqEst -Force }; Set-Content -Path $marcRef -Value (Get-Date) }
  $desde = [datetime]::MinValue; $inicial = $true
  if (Test-Path $arqEst) { try { $desde = [datetime]::ParseExact(([IO.File]::ReadAllText($arqEst)).Trim(), "yyyy-MM-dd HH:mm:ss.fff", $inv); $inicial = $false } catch {} }
  $meses = @("Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")
  # pastas de mes a ler: do mes do ultimo arquivo ja lido ate o mes atual (na primeira vez, os 3 ultimos meses)
  $hoje1 = (Get-Date).Date.AddDays(1 - (Get-Date).Day)
  $m = $hoje1.AddMonths(-2)
  if (-not $inicial) { $m = $desde.Date.AddDays(1 - $desde.Day); if ($m -lt $hoje1.AddMonths(-12)) { $m = $hoje1.AddMonths(-12) } }
  $arqs = New-Object System.Collections.ArrayList
  while ($m -le $hoje1) {
    $p = Join-Path $raizBk ($meses[$m.Month - 1] + "_" + $m.Year)
    $m = $m.AddMonths(1)
    if (-not (Test-Path $p)) { continue }
    foreach ($sub in (Get-ChildItem $p | Where-Object { $_.PSIsContainer -and $_.Name -match "^(MP|PDV)\d" })) {
      foreach ($f in (Get-ChildItem $sub.FullName -Filter "lg_*.mzip")) {
        if ($f.PSIsContainer) { continue }
        if ($f.LastWriteTime -le $desde) { continue }
        if ($f.Name -match "StsPDV|_Ger\d|_RZ\d") { continue }
        [void]$arqs.Add($f)
      }
    }
  }
  if ($arqs.Count -eq 0) { return $false }
  $ordenados = @($arqs | Sort-Object LastWriteTime)
  $tk = ($cfg.token | ConvertTo-Json)
  $lote = New-Object System.Collections.ArrayList
  $lidos = 0; $enviados = 0; $ult = $desde
  foreach ($f in $ordenados) {
    if ($lidos -ge 1500) { break }
    $lidos++
    $ult = $f.LastWriteTime
    try { $t = LeMzip $f.FullName; if ($t) { $j = MontaCupom $t $f.Name; if ($j) { [void]$lote.Add($j) } } } catch {}
    if ($lote.Count -ge 150) {
      $r = RpcBruto "cupons_subir" ('{"p_token":' + $tk + ',"p_cupons":[' + ($lote -join ",") + ']}')
      if (-not $r.ok) { throw "a nuvem recusou os cupons" }
      $enviados += $lote.Count; $lote.Clear()
    }
  }
  if ($lote.Count -gt 0) {
    $r = RpcBruto "cupons_subir" ('{"p_token":' + $tk + ',"p_cupons":[' + ($lote -join ",") + ']}')
    if (-not $r.ok) { throw "a nuvem recusou os cupons" }
    $enviados += $lote.Count; $lote.Clear()
  }
  [IO.File]::WriteAllText($arqEst, $ult.AddMilliseconds(-1).ToString("yyyy-MM-dd HH:mm:ss.fff", $inv))
  if ($inicial -or $lidos -ge 1500) { Escreve ("Cupons: " + $lidos + " arquivos lidos, " + $enviados + " cupons enviados (ate " + $ult.ToString("dd/MM/yyyy HH:mm") + ").") }
  return ($lidos -ge 1500)
}

# Impressora de etiquetas: envia o texto (ZPL) cru para a impressora do Windows, sem passar pelo driver
$RawCs = @"
using System; using System.Runtime.InteropServices;
public class NrRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int l, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static string Envia(string impressora, byte[] dados, string nome) {
    IntPtr h; if (!OpenPrinter(impressora, out h, IntPtr.Zero)) return "nao abriu a impressora (erro " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = nome; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "nao iniciou o documento (erro " + Marshal.GetLastWin32Error() + ")";
      StartPagePrinter(h); int w; bool ok = WritePrinter(h, dados, dados.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
      if (!ok || w != dados.Length) return "envio incompleto (erro " + Marshal.GetLastWin32Error() + ")";
      return "";
    } finally { ClosePrinter(h); }
  }
}
"@
function ListaImpressoras { try { return @(Get-WmiObject Win32_Printer | ForEach-Object { [string]$_.Name }) } catch { return @() } }
function ImprimeEtiqueta($item) {
  $id = [int]$item.id
  $linhas = ([string]$item.conteudo) -split "\r?\n"
  $pedida = ""; $corpo = New-Object System.Collections.ArrayList
  foreach ($ln in $linhas) { if ($ln.StartsWith("--IMPRESSORA ")) { $pedida = $ln.Substring(13).Trim() } elseif (-not $ln.StartsWith("--")) { [void]$corpo.Add($ln) } }
  $lista = ListaImpressoras
  $alvo = ""
  if ($pedida) { $alvo = @($lista | Where-Object { $_ -eq $pedida -or $_ -like ("*" + $pedida + "*") })[0] }
  if (-not $alvo) { $alvo = @($lista | Where-Object { $_ -match "L42|ELGIN" })[0] }
  $res = ""; $ok = $false
  if ($item.tipo -eq "impressoras") { $ok = $true; $res = "IMPRESSORAS NESTE PC:`r`n" + ($lista -join "`r`n") + "`r`n`r`nEscolhida para etiquetas: " + $alvo }
  elseif (-not $alvo) { $res = "ERRO: nenhuma impressora de etiquetas encontrada neste PC. Impressoras instaladas:`r`n" + ($lista -join "`r`n") }
  else {
    try {
      if (-not ("NrRaw" -as [type])) { Add-Type -TypeDefinition $RawCs }
      $bytes = [Text.Encoding]::GetEncoding(1252).GetBytes(($corpo -join "`r`n"))
      $e = [NrRaw]::Envia($alvo, $bytes, ("Etiquetas " + $id))
      if ($e) { $res = "ERRO na impressora " + $alvo + ": " + $e } else { $ok = $true; $res = "IMPRESSO em " + $alvo + " (" + $bytes.Length + " bytes)" }
    } catch { $res = "ERRO: " + $_.Exception.Message }
  }
  $null = Funcao "fila_concluir" @{ id = $id; sucesso = $ok; resultado = $res }
  Escreve ("Pedido " + $id + " (etiquetas): " + ($res -replace "\s+", " ").Substring(0, [Math]::Min(200, ($res -replace "\s+", " ").Length)))
  return $ok
}

# Executa um pedido da fila: grava o SQL num arquivo e roda pelo isql (igual ao .bat antigo)
function Aplica($item) {
  $id = [int]$item.id
  if ($item.tipo -eq "etiqueta" -or $item.tipo -eq "impressoras") { return (ImprimeEtiqueta $item) }
  $arq = Join-Path $Pasta ("fila_" + $id + ".sql")
  $saida = Join-Path $Pasta ("fila_" + $id + "_saida.txt")
  $erro = Join-Path $Pasta ("fila_" + $id + "_erro.txt")
  $enc = [Text.Encoding]::GetEncoding(1252)
  # linhas "--POS {json}" no comeco do pedido = produtos que tambem vao direto para os caixas; nao vao para o isql
  $pos = @(); $sqlLinhas = New-Object System.Collections.ArrayList
  foreach ($ln in ([string]$item.conteudo -split "\r?\n")) {
    if ($ln.StartsWith("--POS ")) { $pos += $ln.Substring(6).Trim() } else { [void]$sqlLinhas.Add($ln) }
  }
  [IO.File]::WriteAllText($arq, ($sqlLinhas -join "`r`n"), $enc)
  foreach ($f in @($saida, $erro)) { if (Test-Path $f) { Remove-Item $f -Force } }
  $argsIsql = @("-u", $cfg.usuario, "-p", $cfg.senha, "-i", $arq, "-o", $saida, $cfg.banco)
  $p = Start-Process -FilePath $cfg.isql -ArgumentList $argsIsql -Wait -PassThru -NoNewWindow -RedirectStandardError $erro
  $txtErro = ""; $txtSaida = ""
  if (Test-Path $erro) { $txtErro = [IO.File]::ReadAllText($erro, $enc).Trim() }
  if (Test-Path $saida) { $txtSaida = [IO.File]::ReadAllText($saida, $enc).Trim() }
  $falhou = ($txtErro.Length -gt 0) -or ($txtSaida -match "Statement failed") -or (-not (Test-Path $saida))
  $resultado = ""
  if ($txtErro) { $resultado += "ERROS DO BANCO:`r`n" + $txtErro + "`r`n`r`n" }
  $resultado += $txtSaida
  if ($resultado.Length -gt 18000) { $resultado = $resultado.Substring(0, 18000) + "`r`n[...]" }
  if ($pos.Count -gt 0) {
    $txtPos = ""
    if ($falhou) { $txtPos = "POS AVISO: nada foi enviado aos caixas porque o Gestao recusou o envio." }
    else { try { $txtPos = EnviaPos $id $pos } catch { $txtPos = "POS ERRO: " + $_.Exception.Message } }
    $resultado += "`r`n`r`n=== POS ===`r`n" + $txtPos
    Escreve ("Pedido " + $id + ": " + (($txtPos -replace "\s+", " ").Substring(0, [Math]::Min(250, ($txtPos -replace "\s+", " ").Length))))
  }
  $null = Funcao "fila_concluir" @{ id = $id; sucesso = (-not $falhou); resultado = $resultado }
  # guarda os ultimos arquivos para conferencia, apaga os antigos
  Get-ChildItem $Pasta -Filter "fila_*" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
  if ($falhou) { Escreve ("Pedido " + $id + " (" + $item.titulo + "): ERRO. " + ($txtErro -replace "\s+", " ").Substring(0, [Math]::Min(300, ($txtErro -replace "\s+", " ").Length))) }
  else { Escreve ("Pedido " + $id + " (" + $item.titulo + "): aplicado no Gestao.") }
  return (-not $falhou)
}

Escreve ("Ouvinte " + $Versao + " iniciado (PID " + $PID + ").")
$ultimaBatida = Get-Date "2000-01-01"
$ultimaVenda = (Get-Date).AddSeconds(-270)
$erroVenda = ""
$ultimoCupom = (Get-Date).AddSeconds(-240)
$erroCupom = ""
$ultimoErro = ""
while ($true) {
  try {
    Set-Content -Path $Vivo -Value $PID
    if (Test-Path $Parar) { Escreve "Pedido para parar. Encerrando."; Remove-Item $Parar -Force; break }
    if ((Get-Item $Eu).LastWriteTime -ne $MeuCarimbo) { Escreve "Ouvinte atualizado; reiniciando na proxima passada do agente."; break }
    if (((Get-Date) - $ultimaBatida).TotalSeconds -ge 60) { $null = Rpc "ouvinte_bate" @{ p_token = $cfg.token; p_versao = $Versao }; $ultimaBatida = Get-Date; try { ReentregaPos } catch { Escreve ("POS: nao consegui conferir os caixas: " + $_.Exception.Message) } }
    if (((Get-Date) - $ultimaVenda).TotalSeconds -ge 300) {
      $ultimaVenda = Get-Date
      try { SobeVendas; $erroVenda = "" } catch { $mv = $_.Exception.Message; if ($mv -ne $erroVenda) { Escreve ("Vendas: " + $mv); $erroVenda = $mv } }
    }
    if (((Get-Date) - $ultimoCupom).TotalSeconds -ge 300) {
      $ultimoCupom = Get-Date
      try { $temMais = SobeCupons; $erroCupom = ""; if ($temMais -eq $true) { $ultimoCupom = (Get-Date).AddSeconds(-280) } } catch { $mc = $_.Exception.Message; if ($mc -ne $erroCupom) { Escreve ("Cupons: " + $mc); $erroCupom = $mc } }
    }
    $n = [int](Rpc "fila_pendente" @{ p_token = $cfg.token })
    if ($n -gt 0) {
      $aplicou = $false
      for ($i = 0; $i -lt 20; $i++) {
        $r = Funcao "fila_pegar" $null
        if (-not $r.item) { break }
        $ok = Aplica $r.item
        $aplicou = $true
      }
      if ($aplicou) {
        # sobe o estoque/precos novos para a nuvem agora, sem esperar os 5 minutos
        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", (Join-Path $Pasta "agente.ps1")) -WindowStyle Hidden -Wait
      }
    }
    $ultimoErro = ""
    Start-Sleep -Seconds 4
  } catch {
    $m = $_.Exception.Message
    if ($m -ne $ultimoErro) { Escreve ("ERRO: " + $m); $ultimoErro = $m }
    Start-Sleep -Seconds 20
  }
}
# FIM-DO-ARQUIVO
