@echo off
echo ====================================================
echo  Starting local web server for Mantiq...
echo  Open http://localhost:8000 in your browser.
echo  Press Ctrl+C to stop the server.
echo ====================================================
echo.

python -m http.server 800
