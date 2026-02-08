@echo off
echo ========================================
echo Film Processor - Distribution Packager
echo ========================================
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
xcopy /E /I /Y ".venv" "FilmProcessor-Release\resources\app\.venv"
copy /Y "pyproject.toml" "FilmProcessor-Release\resources\app\"
copy /Y "electron-main.js" "FilmProcessor-Release\resources\app\"
copy /Y "preload.js" "FilmProcessor-Release\resources\app\"
copy /Y "package.json" "FilmProcessor-Release\resources\app\"

REM Rename electron.exe to FilmProcessor.exe
ren "FilmProcessor-Release\electron.exe" "FilmProcessor.exe"
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
echo 3. Wait for the app to start (first launch may take 10-15 seconds)
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

REM Create ZIP file
echo Creating ZIP file...
powershell -command "Compress-Archive -Path 'FilmProcessor-Release\*' -DestinationPath 'FilmProcessor-Release.zip' -Force"
echo ✓ ZIP file created
echo.

echo ========================================
echo BUILD COMPLETE!
echo ========================================
echo.
echo Distribution package: FilmProcessor-Release.zip
echo Size: 
powershell -command "(Get-Item FilmProcessor-Release.zip).length / 1MB | ForEach-Object { '{0:N2} MB' -f $_ }"
echo.
echo Ready to distribute! Send FilmProcessor-Release.zip to users.
echo They just need to extract and run FilmProcessor.exe
echo.
pause
