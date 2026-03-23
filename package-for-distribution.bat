@echo off
echo ========================================
echo Film Processor - Distribution Packager
echo ========================================
echo.

REM Kill any running FilmProcessor instances
echo Checking for running FilmProcessor instances...
taskkill /F /IM FilmProcessor.exe 2>nul
taskkill /F /IM electron.exe 2>nul
echo Waiting for processes to fully terminate...
timeout /t 5 /nobreak >nul
echo.

REM Skip electron-builder completely - manual packaging
echo [1/4] Creating distribution folder...
if exist "FilmProcessor-Release" rmdir /s /q "FilmProcessor-Release"
mkdir "FilmProcessor-Release"
mkdir "FilmProcessor-Release\resources"
mkdir "FilmProcessor-Release\resources\app"
echo ✓ Folders created
echo.

REM Step 2: Copy Electron runtime
echo [2/4] Copying Electron runtime...
xcopy /E /I /Y "node_modules\electron\dist\*" "FilmProcessor-Release\"
echo ✓ Electron runtime copied
echo.

REM Step 3: Copy application files into resources/app
echo [3/4] Copying application files...
xcopy /E /I /Y "src" "FilmProcessor-Release\resources\app\src"
xcopy /E /I /Y "static" "FilmProcessor-Release\resources\app\static"
xcopy /E /I /Y "templates" "FilmProcessor-Release\resources\app\templates"
copy /Y "pyproject.toml" "FilmProcessor-Release\resources\app\"
copy /Y "electron-main.js" "FilmProcessor-Release\resources\app\"
copy /Y "preload.js" "FilmProcessor-Release\resources\app\"
copy /Y "package.json" "FilmProcessor-Release\resources\app\"

REM Copy Python runtime to correct location
echo Copying Python runtime...
xcopy /E /I /Y ".venv" "FilmProcessor-Release\resources\python_runtime"
echo ✓ Python runtime copied

REM Install production dependencies
echo Installing dependencies...
cd "FilmProcessor-Release\resources\app"
call npm install --production --omit=dev
cd ..\..\..
echo ✓ Dependencies installed

REM Rename electron.exe to FilmProcessor.exe
cd FilmProcessor-Release
ren electron.exe FilmProcessor.exe
cd ..
echo ✓ Application files copied
echo.

REM Create README for users
echo [4/4] Creating user instructions and packaging...
(
echo Film Processor - Professional Film Processing Tool
echo.
echo INSTALLATION:
echo 1. Extract this entire folder to your desired location
echo 2. Double-click FilmProcessor.exe
echo 3. Wait for the app to start ^(first launch may take 10-15 seconds^)
echo.
echo USAGE:
echo - Click to select an image file
echo - Use sliders to adjust tone and color
echo - Use curves for advanced control
echo - Click Export to save your edited image
echo - Settings auto-save with each image
echo.
echo SYSTEM REQUIREMENTS:
echo - Windows 10 or later
echo - 4GB RAM minimum
echo - No additional software needed - everything is included!
echo.
echo TROUBLESHOOTING:
echo - If app doesn't start, run as administrator
echo - Antivirus may flag first run - this is normal for unsigned apps
echo - For support, contact the developer
echo.
) > "FilmProcessor-Release\README.txt"

REM Create ZIP file - Skip if files are locked
echo Creating ZIP file...
if exist "FilmProcessor-Release.zip" del "FilmProcessor-Release.zip" 2>nul
tar -a -c -f FilmProcessor-Release.zip FilmProcessor-Release 2>nul
if %errorlevel% neq 0 (
    echo Warning: Could not create ZIP automatically ^(files may be in use^)
    echo You can manually ZIP the FilmProcessor-Release folder
) else (
    echo ✓ ZIP file created
)
echo.

echo ========================================
echo BUILD COMPLETE!
echo ========================================
echo.
if exist "FilmProcessor-Release.zip" (
    echo Distribution package: FilmProcessor-Release.zip
    echo Size: 
    powershell -command "(Get-Item FilmProcessor-Release.zip).length / 1MB | ForEach-Object { '{0:N2} MB' -f $_ }"
    echo.
    echo Ready to distribute! Send FilmProcessor-Release.zip to users.
    echo They just need to extract and run FilmProcessor.exe
) else (
    echo Distribution folder: FilmProcessor-Release\
    echo.
    echo ZIP creation failed. You can:
    echo 1. Manually ZIP the FilmProcessor-Release folder
    echo 2. Or distribute the FilmProcessor-Release folder directly
)
echo.
pause
