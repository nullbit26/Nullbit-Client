@echo off
title Управление Армией Стражников

:: Эта строчка заставляет консоль перейти в ту же папку, где лежит этот .bat файл
cd /d "%~dp0"

echo Запускаем процесс призыва армии...
echo.

start "Army Bots" node sex_army_test.js

echo Армия запущена. Ожидаем 70 секунд пока все заспавнятся...
timeout /t 70 /nobreak

echo Раздаём снарягу...
node give_gear.js

echo.
echo Готово! Теперь напиши в чат:  !squad gear
echo.
pause