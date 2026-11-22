' Inicia a estacao de etiquetas escondida (sem janela). Chamado pela tarefa "Nova Raphaella Etiquetas".
Set fso = CreateObject("Scripting.FileSystemObject")
p = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & p & "\etiquetas.ps1""", 0, False
