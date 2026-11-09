Option Explicit
Dim shell, fso, scriptDirectory, scriptPath, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(scriptDirectory, "Start-YukinoChat.ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File """ & scriptPath & """"
result = shell.Run(command, 0, True)
If result <> 0 Then
    MsgBox "Yukino Chat could not start. See logs\launcher.log in the application folder.", vbExclamation, "Yukino Chat"
End If
WScript.Quit result
