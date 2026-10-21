@echo off
rem Kosmolet launcher: starts Electron without a console window, from the project folder.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
