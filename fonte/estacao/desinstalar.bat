@echo off
set "DEST=%LOCALAPPDATA%\NovaRaphaella\Etiquetas"
schtasks /delete /tn "Nova Raphaella Etiquetas" /f
echo.> "%DEST%\etiquetas.parar"
echo Estacao de etiquetas desligada. Os pedidos de etiqueta voltam a ficar na fila ate religar.
pause
