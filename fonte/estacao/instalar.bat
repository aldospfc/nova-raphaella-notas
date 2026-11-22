@echo off
title Instalar estacao de etiquetas - Nova Raphaella
set "DEST=%LOCALAPPDATA%\NovaRaphaella\Etiquetas"
echo Instalando em %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
if exist "%DEST%\etiquetas.alive" echo.> "%DEST%\etiquetas.parar"
copy /y "%~dp0etiquetas.ps1" "%DEST%\" >nul || goto erro
copy /y "%~dp0config.json" "%DEST%\" >nul || goto erro
copy /y "%~dp0iniciar.vbs" "%DEST%\" >nul || goto erro
copy /y "%~dp0desinstalar.bat" "%DEST%\" >nul
schtasks /create /tn "Nova Raphaella Etiquetas" /sc minute /mo 5 /tr "wscript.exe \"%DEST%\iniciar.vbs\"" /f >nul || goto erro
timeout /t 6 /nobreak >nul
del /q "%DEST%\etiquetas.parar" 2>nul
del /q "%DEST%\etiquetas.alive" 2>nul
wscript.exe "%DEST%\iniciar.vbs"
echo.
echo PRONTO. A estacao de etiquetas esta ligada e volta sozinha a cada 5 minutos.
echo Pode fechar esta janela.
pause
exit /b 0
:erro
echo.
echo DEU ERRO na instalacao. Tire um print desta janela e mande para o Claude.
pause
exit /b 1
