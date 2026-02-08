@echo off
echo Building Film Processor...
echo.

REM Build the Electron app
echo Step 1: Building Electron executable...
call npm run build:win

echo.
echo Build complete! 
echo.
echo The portable .exe file is in: dist\FilmProcessor-Portable.exe
echo.
echo IMPORTANT: To distribute this app, you need to include:
echo   1. FilmProcessor-Portable.exe
echo   2. Python environment (user needs Python + uv installed)
echo   3. Or bundle Python runtime separately
echo.
pause
