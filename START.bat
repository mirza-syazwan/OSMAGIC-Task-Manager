@echo off
title GPS Trace Task Manager Server
color 0A
echo.
echo ========================================
echo   GPS Trace Task Manager Server
echo ========================================
echo.
echo Starting server...
echo.
echo Your app will be available at:
echo   http://localhost:8000
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.
python server.py
pause

