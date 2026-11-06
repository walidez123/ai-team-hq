@echo off
title AI Team HQ
cd /d "%~dp0"
start "" http://127.0.0.1:4357
node ui\server.js
pause
