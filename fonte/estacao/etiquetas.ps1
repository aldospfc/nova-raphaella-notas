# Estacao de etiquetas Nova Raphaella - roda no PC onde a impressora de etiquetas esta ligada (ex.: caixa 2 da Loja 1).
# So imprime: pega na nuvem os pedidos de etiqueta da loja e manda o ZPL cru para a impressora local.
# 1.1.0: etiquetas de envio (Mercado Livre/Shopee, tipo "etiqueta_envio") vao para a Zebra; gondola continua na Elgin.
# Nao mexe no Gestao, no caixa nem em vendas. E' mantida viva pela tarefa "Nova Raphaella Etiquetas" (a cada 5 min).
$ErrorActionPreference = "Stop"
$Versao = "1.1.0"
$Pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Pasta "etiquetas.log"
$Vivo = Join-Path $Pasta "etiquetas.alive"
$Parar = Join-Path $Pasta "etiquetas.parar"
$Eu = $MyInvocation.MyCommand.Path

function Escreve($t) {
  $linha = (Get-Date -Format "dd/MM/yyyy HH:mm:ss") + "  " + $t
  try {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 2MB) { Move-Item $Log ($Log + ".old") -Force }
    Add-Content -Path $Log -Value $linha -Encoding UTF8
  } catch {}
  Write-Host $linha
}

# So uma copia por vez: se o arquivo "alive" foi tocado ha menos de 40 s, ja tem outra rodando
if (Test-Path $Vivo) {
  $idade = (Get-Date) - (Get-Item $Vivo).LastWriteTime
  if ($idade.TotalSeconds -lt 40) { exit 0 }
}
Set-Content -Path $Vivo -Value $PID
if (Test-Path $Parar) { Remove-Item $Parar -Force }

$cfg = Get-Content (Join-Path $Pasta "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = ([string]$cfg.url).TrimEnd("/") -replace "/functions/v1/.*$", "" -replace "/rest/v1.*$", ""
$chave = if ($cfg.chave) { $cfg.chave } else { "sb_publishable_JpyH0LLreCW8yhMVqa7Dig_m6ejXawT" }
$cab = @{ "apikey" = $chave; "Authorization" = "Bearer " + $chave }

function Rpc($nome, $corpo) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Compress -Depth 6))
  return Invoke-RestMethod -Uri ($base + "/rest/v1/rpc/" + $nome) -Method Post -Headers $cab -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 30
}

# Envia o texto (ZPL) cru para a impressora do Windows, sem passar pelo driver
$RawCs = @"
using System; using System.Runtime.InteropServices;
public class NrRawEst {
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
$ReElgin = "L42|ELGIN"
$ReZebra = "ZDesigner|Zebra|\bZD\d"

function Imprime($item) {
  $id = [long]$item.id
  $linhas = ([string]$item.conteudo) -split "\r?\n"
  $pedida = ""; $corpo = New-Object System.Collections.ArrayList
  foreach ($ln in $linhas) { if ($ln.StartsWith("--IMPRESSORA ")) { $pedida = $ln.Substring(13).Trim() } elseif (-not $ln.StartsWith("--")) { [void]$corpo.Add($ln) } }
  $lista = ListaImpressoras
  $envio = ($item.tipo -eq "etiqueta_envio")
  $alvo = ""
  if ($envio) {
    # etiqueta de envio: Zebra (nunca a Elgin da gondola)
    if ($cfg.impressora_envio) { $alvo = @($lista | Where-Object { $_ -eq [string]$cfg.impressora_envio })[0] }
    if (-not $alvo) { $alvo = @($lista | Where-Object { $_ -match $ReZebra -and $_ -notmatch $ReElgin })[0] }
  } else {
    if ($cfg.impressora) { $alvo = @($lista | Where-Object { $_ -eq [string]$cfg.impressora })[0] }
    if (-not $alvo -and $pedida) { $alvo = @($lista | Where-Object { ($_ -eq $pedida -or $_ -like ("*" + $pedida + "*")) -and $_ -match $ReElgin })[0] }
    if (-not $alvo) { $alvo = @($lista | Where-Object { $_ -match $ReElgin })[0] }
  }
  $res = ""; $ok = $false
  if ($item.tipo -eq "impressoras") {
    $z = @($lista | Where-Object { $_ -match $ReZebra -and $_ -notmatch $ReElgin })[0]
    $ok = $true; $res = "IMPRESSORAS NESTE PC (" + $env:COMPUTERNAME + "):`r`n" + ($lista -join "`r`n") + "`r`n`r`nEscolhida para etiquetas de gondola: " + $alvo + "`r`nEscolhida para etiquetas de envio: " + $z
  }
  elseif (-not $alvo) { $res = "ERRO: nenhuma impressora " + $(if ($envio) { "Zebra (etiqueta de envio)" } else { "Elgin/L42" }) + " encontrada no " + $env:COMPUTERNAME + ". Impressoras instaladas:`r`n" + ($lista -join "`r`n") }
  else {
    try {
      if (-not ("NrRawEst" -as [type])) { Add-Type -TypeDefinition $RawCs }
      # gondola: ZPL montado pelo site em Windows-1252; envio: ZPL do Mercado Livre/Shopee em UTF-8
      $cod = if ($envio) { New-Object System.Text.UTF8Encoding($false) } else { [Text.Encoding]::GetEncoding(1252) }
      $bytes = $cod.GetBytes(($corpo -join "`r`n"))
      $e = [NrRawEst]::Envia($alvo, $bytes, $(if ($envio) { "Etiqueta de envio " + $id } else { "Etiquetas " + $id }))
      if ($e) { $res = "ERRO na impressora " + $alvo + ": " + $e } else { $ok = $true; $res = "IMPRESSO em " + $alvo + " no " + $env:COMPUTERNAME + " (" + $bytes.Length + " bytes)" }
    } catch { $res = "ERRO: " + $_.Exception.Message }
  }
  $null = Rpc "estacao_concluir" @{ p_token = $cfg.token; p_id = $id; p_ok = $ok; p_resultado = $res }
  $curto = ($res -replace "\s+", " ")
  Escreve ("Pedido " + $id + ": " + $curto.Substring(0, [Math]::Min(200, $curto.Length)))
}

# Atualizacao automatica: baixa a versao nova, confere a sintaxe e troca o arquivo; a tarefa reinicia em ate 5 min
function Atualiza($alvoVersao) {
  $p = Rpc "estacao_programa" @{ p_token = $cfg.token }
  if (-not $p -or -not $p.conteudo -or $p.versao -ne $alvoVersao) { return $false }
  $erros = $null
  $null = [System.Management.Automation.PSParser]::Tokenize([string]$p.conteudo, [ref]$erros)
  if ($erros -and $erros.Count -gt 0) { Escreve ("Versao " + $alvoVersao + " recusada (erro de sintaxe)."); return $false }
  $novo = $Eu + ".novo"
  $enc = New-Object System.Text.UTF8Encoding($true)
  [IO.File]::WriteAllText($novo, [string]$p.conteudo, $enc)
  Copy-Item $Eu ($Eu + ".anterior") -Force
  Move-Item $novo $Eu -Force
  Escreve ("Atualizado para a versao " + $alvoVersao + "; reiniciando.")
  return $true
}

Escreve ("Estacao de etiquetas " + $Versao + " iniciada no " + $env:COMPUTERNAME + " (PID " + $PID + ").")
try { $d = [int](Rpc "estacao_devolver" @{ p_token = $cfg.token }); if ($d -gt 0) { Escreve ($d.ToString() + " pedido(s) interrompido(s) voltaram para a fila.") } } catch { Escreve ("Aviso: " + $_.Exception.Message) }
$ultimaBatida = Get-Date "2000-01-01"
$ultimoErro = ""
while ($true) {
  try {
    Set-Content -Path $Vivo -Value $PID
    if (Test-Path $Parar) { Escreve "Pedido para parar. Encerrando."; Remove-Item $Parar -Force; break }
    if (((Get-Date) - $ultimaBatida).TotalSeconds -ge 60) {
      $ultimaBatida = Get-Date
      $imp = @(ListaImpressoras | Where-Object { $_ -match $ReElgin -or $_ -match $ReZebra })
      $b = Rpc "estacao_bate" @{ p_token = $cfg.token; p_versao = $Versao; p_info = @{ pc = $env:COMPUTERNAME; impressoras = $imp } }
      if (-not $b.ok) { throw ("nuvem recusou: " + $b.erro) }
      if ($b.versao -and $b.versao -ne $Versao) { if (Atualiza ([string]$b.versao)) { break } }
    }
    $n = [int](Rpc "estacao_pendente" @{ p_token = $cfg.token })
    if ($n -gt 0) {
      for ($i = 0; $i -lt 20; $i++) {
        $r = @(Rpc "estacao_pegar" @{ p_token = $cfg.token })
        if ($r.Count -eq 0 -or -not $r[0] -or -not $r[0].id) { break }
        Imprime $r[0]
      }
    }
    $ultimoErro = ""
    Start-Sleep -Seconds 3
  } catch {
    $m = $_.Exception.Message
    if ($m -ne $ultimoErro) { Escreve ("ERRO: " + $m); $ultimoErro = $m }
    Start-Sleep -Seconds 20
  }
}
Remove-Item $Vivo -Force -ErrorAction SilentlyContinue
# FIM-DO-ARQUIVO
