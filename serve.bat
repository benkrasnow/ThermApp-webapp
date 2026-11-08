@echo off
rem Serve this folder at http://localhost:8765 and open the Therm-App web app in Edge.
rem WebUSB needs http://localhost (or https), so the page can't be opened as a plain file.
rem Needs Python 3 (https://www.python.org/downloads/); any static web server works too.
cd /d "%~dp0"
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
where %PY% >nul 2>nul || set PY=py
start "" msedge "http://localhost:8765/web/"
%PY% -m http.server 8765 --bind 127.0.0.1
