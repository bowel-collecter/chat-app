@echo off
TITLE land ki baatein - Launcher
echo Starting land ki baatein server and static tunnel...

:: Start the Node.js backend server in a background process
start cmd /k "node server.js"

:: Wait 2 seconds for the server to spin up
timeout /t 2 /nobreak > nul

:: Start the LocalTunnel permanent link in a background process
start cmd /k "lt --port 3000 --subdomain land-ki-baatein-chat"

:: Open your local app directly in your default browser
start http://localhost:3000

echo App launched successfully! You can close this window.
pause