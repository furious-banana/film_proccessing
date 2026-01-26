@echo off
REM Development helper for Film Processing

if "%1"=="install" (
    echo Installing dependencies...
    uv sync --extra dev
    goto :eof
)

if "%1"=="run" (
    echo Starting application...
    echo Application will be available at http://localhost:5000
    echo Press Ctrl+C to stop
    uv run python main.py
    goto :eof
)

if "%1"=="test" (
    echo Running basic tests...
    uv run python tests/test_basic.py
    goto :eof
)

if "%1"=="clean" (
    echo Cleaning cache files...
    for /d /r . %%d in (__pycache__) do @if exist "%%d" rmdir /s /q "%%d"
    if exist .pytest_cache rmdir /s /q .pytest_cache
    goto :eof
)

echo Usage: dev.bat [install^|run^|test^|clean]
echo.
echo Commands:
echo   install  - Install project and dev dependencies  
echo   run      - Start the web application
echo   test     - Run tests
echo   clean    - Remove cache files
