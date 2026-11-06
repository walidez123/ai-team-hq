@echo off
rem =============================================================
rem  OpenCode factory-reset FINISHER — run AFTER closing ALL
rem  OpenCode windows (this includes the desktop app).
rem
rem  Deletes the 1 GB session history DB and every runtime cache.
rem  Nothing in your live profile is kept. The AI Team's global
rem  files (agents, commands, skills, crew card) ARE KEPT.
rem =============================================================
setlocal
echo.
echo  AI Team — finishing the OpenCode factory reset
echo  ------------------------------------------------------
echo  Closing check: if OpenCode is still running, this will fail and hurt nothing.
echo.
pause

rem  --- the 1 GB history database ---
del /f /q "%USERPROFILE%\.local\share\opencode\opencode.db"      2>nul && echo  [ok] opencode.db deleted || echo  [kept] opencode.db is still locked - close OpenCode and rerun
del /f /q "%USERPROFILE%\.local\share\opencode\opencode.db-shm"  2>nul
del /f /q "%USERPROFILE%\.local\share\opencode\opencode.db-wal"  2>nul

rem  --- runtime caches (app recreates them on next launch) ---
rmdir /s /q "%USERPROFILE%\.local\share\opencode\log"         2>nul && echo  [ok] log
rmdir /s /q "%USERPROFILE%\.local\share\opencode\shell"        2>nul && echo  [ok] shell
rmdir /s /q "%USERPROFILE%\.local\share\opencode\snapshot"     2>nul && echo  [ok] snapshot
rmdir /s /q "%USERPROFILE%\.local\share\opencode\repos"        2>nul && echo  [ok] repos
rmdir /s /q "%USERPROFILE%\.local\share\opencode\tool-output"  2>nul && echo  [ok] tool-output
rmdir /s /q "%USERPROFILE%\.local\state\opencode"              2>nul && echo  [ok] state
rmdir /s /q "%USERPROFILE%\.cache\opencode"                    2>nul && echo  [ok] cache

rem  --- stale plugins/config debris, if any crept back in ---
rmdir /s /q "%USERPROFILE%\.config\opencode\node_modules"      2>nul

echo.
echo  Done. Relaunch the OpenCode app when you want a fresh install.
echo  Your AI Team (agents, commands, skills, crew card) is already reinstalled globally.
echo  Backup folder to delete when you are fully sure:
echo    rd /s /q "%USERPROFILE%\opencode-reset-backup-2026-11-06"
echo.
pause
endlocal
