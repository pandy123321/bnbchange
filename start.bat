@echo off
cd /d %~dp0

if not exist "dist\index.html" (
  echo [ERROR] dist not found. Run "npm install" then "npm run build" first.
  pause
  exit /b 1
)

start "bnb-tool-server" cmd /c "node serve.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:4173

echo.
echo Server running at http://127.0.0.1:4173
echo Close the server window to stop.
pause
