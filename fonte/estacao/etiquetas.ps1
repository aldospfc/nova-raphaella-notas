# Estacao de etiquetas Nova Raphaella - roda no PC onde a impressora de etiquetas esta ligada (ex.: caixa 2 da Loja 1).
# So imprime: pega na nuvem os pedidos de etiqueta da loja e manda o ZPL cru para a impressora local.
# 1.1.0: etiquetas de envio (Mercado Livre/Shopee, tipo "etiqueta_envio") vao para a Zebra; gondola continua na Elgin.
# 1.2.0: diagnostico da fila do Windows (porta, offline/pausada, documentos parados) no pedido "impressoras" e no resultado de cada impressao.
# 1.3.0: etiqueta de envio vai pelo Zebra Browser Print (o mesmo caminho da pagina do Mercado Livre, que segura a Zebra na USB);
#        so se ele nao responder usa a fila do Windows. Tira da fila do Windows as etiquetas de envio que ficaram travadas.
# Nao mexe no Gestao, no caixa nem em vendas. E' mantida viva pela tarefa "Nova Raphaella Etiquetas" (a cada 5 min).
$ErrorActionPreference = "Stop"
$Versao = "1.3.1"
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

# Situacao de uma impressora no Windows: porta, offline/pausada/erro e documentos na fila
$StatusImp = @{ 1 = "outro"; 2 = "desconhecido"; 3 = "pronta"; 4 = "imprimindo"; 5 = "aquecendo"; 6 = "parada"; 7 = "OFFLINE" }
function SituacaoImpressora($nome) {
  try {
    $p = @(Get-WmiObject Win32_Printer | Where-Object { $_.Name -eq $nome })[0]
    if (-not $p) { return "nao encontrada" }
    $t = "porta " + $p.PortName + ", " + $StatusImp[[int]$p.PrinterStatus]
    if ($p.WorkOffline) { $t += ", USAR OFFLINE ligado" }
    if ([int]$p.DetectedErrorState -gt 2) { $t += ", erro detectado " + $p.DetectedErrorState }
    if (([int]$p.Attributes -band 0x400) -ne 0) { $t += ", PAUSADA" }
    $jobs = @(Get-WmiObject Win32_PrintJob | Where-Object { $_.Name -like ($nome + ",*") })
    $t += ", " + $jobs.Count + " documento(s) na fila"
    foreach ($j in ($jobs | Select-Object -First 5)) { $t += "`r`n    - " + $j.Document + " (" + $j.JobStatus + $j.Status + ")" }
    return $t
  } catch { return "sem diagnostico: " + $_.Exception.Message }
}
# Zebra Browser Print (programa da Zebra neste PC, porta 9100): manda o ZPL direto para a impressora padrao dele
function ViaBrowserPrint($zpl) {
  $bp = "http://127.0.0.1:9100"
  foreach ($origem in @("", "https://sistema.novaraphaella.com.br")) {
    try {
      $h = @{}; if ($origem) { $h["Origin"] = $origem }
      $dev = Invoke-RestMethod -Uri ($bp + "/default?type=printer") -Headers $h -TimeoutSec 8
      if ($dev -is [string]) { $dev = if ($dev.Trim()) { $dev | ConvertFrom-Json } else { $null } }
      if (-not $dev -or -not $dev.name) { return @{ ok = $false; msg = "o Browser Print nao tem impressora padrao escolhida" } }
      $corpo = @{ device = $dev; data = $zpl } | ConvertTo-Json -Compress -Depth 6
      $null = Invoke-RestMethod -Uri ($bp + "/write") -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($corpo)) -ContentType "text/plain;charset=UTF-8" -TimeoutSec 30
      return @{ ok = $true; msg = [string]$dev.name }
    } catch { $ultimo = $_.Exception.Message }
  }
  return @{ ok = $false; msg = "Browser Print nao respondeu (" + $ultimo + ")" }
}
# Etiquetas de envio desta estacao que travaram na fila do Windows (a Zebra presa pelo Browser Print): tira da fila para nao sairem repetidas depois
function LimpaTravadas($nome) {
  $n = 0
  try { foreach ($j in @(Get-WmiObject Win32_PrintJob | Where-Object { $_.Name -like ($nome + ",*") -and [string]$_.Document -like "Etiqueta de envio*" })) { try { $j.Delete(); $n++ } catch {} } } catch {}
  return $n
}
function Diagnostico {
  $t = ""
  foreach ($n in (ListaImpressoras | Where-Object { $_ -match $ReZebra -or $_ -match $ReElgin })) { $t += "`r`n* " + $n + ": " + (SituacaoImpressora $n) }
  try { $pp = @(Get-PrinterPort -ErrorAction Stop | Where-Object { $_.Name -match "USB|TMUSB|ZD|ZBR" } | ForEach-Object { $_.Name + " = " + $_.Description }); if ($pp.Count) { $t += "`r`nPortas USB de impressora: " + ($pp -join "; ") } } catch {}
  try { $dv = @(Get-WmiObject Win32_PnPEntity | Where-Object { $_.Name -match "Zebra|ZD2|ZDesigner|Elgin|L42" } | ForEach-Object { $_.Name + " [" + $_.Status + "]" }); $t += "`r`nAparelhos ligados no USB: " + $(if ($dv.Count) { $dv -join "; " } else { "nenhum Zebra/Elgin detectado" }) } catch {}
  return $t
}

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
    $ok = $true; $res = "IMPRESSORAS NESTE PC (" + $env:COMPUTERNAME + "):`r`n" + ($lista -join "`r`n") + "`r`n`r`nEscolhida para etiquetas de gondola: " + $alvo + "`r`nEscolhida para etiquetas de envio: " + $z + "`r`n`r`nSITUACAO NO WINDOWS:" + (Diagnostico)
  }
  elseif (-not $alvo -and -not $envio) { $res = "ERRO: nenhuma impressora " + $(if ($envio) { "Zebra (etiqueta de envio)" } else { "Elgin/L42" }) + " encontrada no " + $env:COMPUTERNAME + ". Impressoras instaladas:`r`n" + ($lista -join "`r`n") }
  else {
    try {
      if ($envio) {
        # 1o caminho: Browser Print (o mesmo da pagina do Mercado Livre)
        $lt = LimpaTravadas $alvo
        $bp = ViaBrowserPrint (($corpo -join "`r`n"))
        if ($bp.ok) {
          $ok = $true; $res = "IMPRESSO em " + $bp.msg + " pelo Browser Print no " + $env:COMPUTERNAME + $(if ($lt) { " (" + $lt + " travada(s) tirada(s) da fila do Windows)" } else { "" })
          $null = Rpc "estacao_concluir" @{ p_token = $cfg.token; p_id = $id; p_ok = $ok; p_resultado = $res }
          Escreve ("Pedido " + $id + ": " + $res); return
        }
        Escreve ("Pedido " + $id + ": " + $bp.msg + "; tentando pela fila do Windows.")
      }
      if (-not ("NrRawEst" -as [type])) { Add-Type -TypeDefinition $RawCs }
      # gondola: ZPL montado pelo site em Windows-1252; envio: ZPL do Mercado Livre/Shopee em UTF-8
      $cod = if ($envio) { New-Object System.Text.UTF8Encoding($false) } else { [Text.Encoding]::GetEncoding(1252) }
      $bytes = $cod.GetBytes(($corpo -join "`r`n"))
      $e = [NrRawEst]::Envia($alvo, $bytes, $(if ($envio) { "Etiqueta de envio " + $id } else { "Etiquetas " + $id }))
      if ($e) { $res = "ERRO na impressora " + $alvo + ": " + $e } else { $ok = $true; Start-Sleep -Milliseconds 1500; $res = "IMPRESSO em " + $alvo + " no " + $env:COMPUTERNAME + " (" + $bytes.Length + " bytes) | " + (SituacaoImpressora $alvo) }
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
