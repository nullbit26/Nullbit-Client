# Release Build System v2.1 - Cyberpunk Launcher

## Overview

Система сборки релиза NULLBIT для распространения в виде Windows .exe файлов с лицензионной защитой KeyAuth и автообновлением через киберпанк-лаунчер.

**Статус:** ✅ Активно используется  
**Дата:** 2026-05-20  
**Версия:** v2.1 (esbuild bundle + Cyberpunk Launcher)

## Архитектура

### Компоненты сборки

```
┌─────────────────────────────────────────────────────────────┐
│  Исходный код проекта (index.js, systems/, core/, etc.)    │
└─────────────────────────────────────────────────────────────┘
                           ↓
                    esbuild bundle
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Single bundle.js (все модули встроены)                     │
│  - Обработка всех require()                                 │
│  - Минификация кода                                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
              Встраивание лицензии + pkg
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  AIBot.exe (554 MB)                                         │
│  - KeyAuth проверка при запуске                             │
│  - HWID привязка                                            │
│  - Весь код внутри бинарника                                │
└─────────────────────────────────────────────────────────────┘
                           ↓
              Launcher.exe запускает бота
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Launcher.exe (58 MB) - Cyberpunk Edition                   │
│  - ASCII-логотип NULLBIT (figlet)                          │
│  - Глитч-эффекты в консоли                                  │
│  - Автообновление с прогресс-баром                           │
│  - Управление процессом бота                                 │
└─────────────────────────────────────────────────────────────┘
```

## KeyAuth Интеграция

### Двухэтапная авторизация

1. **Init Session** — создание сессии
   ```
   GET https://keyauth.win/api/1.2/?type=init
   Parameters:
     - name: App Name (из конфига)
     - ownerid: Owner ID (из конфига)
     - version: 1.0
   
   Response: { success: true, sessionid: "xxx" }
   ```

2. **License Check** — проверка ключа
   ```
   POST https://keyauth.win/api/1.2/
   Body:
     - type: "license"
     - key: license_key из config.json
     - hwid: сгенерированный HWID
     - sessionid: из шага 1
     - name, ownerid, secret, version
   
   Response: { success: true/false, info: {...} }
   ```

### Генерация HWID

```javascript
function generateHWID() {
  // MAC адрес + CPU info + Hostname
  const hwidString = `${macAddress}-${cpuInfo}-${os.hostname()}`;
  return sha256(hwidString).substring(0, 32);
}
```

## Файлы системы

| Файл | Назначение |
|------|-----------|
| `scripts/build-v2.js` | Основной скрипт сборки (7 шагов) |
| `scripts/verify-build.js` | Проверка готовности к сборке |
| `scripts/license-check.js` | Модуль проверки лицензии (для разработки) |
| `scripts/launcher.js` | Cyberpunk-лаунчер с автообновлением |
| `BUILD_SETUP.md` | Полная инструкция по сборке |

## Cyberpunk Launcher (v2.1)

### Фичи лаунчера

- **ASCII-логотип NULLBIT** через figlet (шрифт ANSI Shadow)
- **Глитч-эффекты** — случайная смена регистра и спецсимволы (#, @, _, █)
- **Хакерские статусы** — `[ SYS ]`, `[ OK ]`, `[ ERR ]`, `[ WARN ]` в капсе
- **Киберпанк прогресс-бар** — `DOWNLOADING [████░░░░░░] 45% | 350/700 MB`
- **Глитч-оповещения** — красный мерцающий `[ ! ] ОБНАРУЖЕНА НОВАЯ СБОРКА`
- **Управление процессом** — лаунчер остается висеть, при закрытии убивает бота

### Интерфейс лаунчера

```
╔════════════════════════════════════════════════════════╗
║  ███╗   ██╗██╗   ██╗██╗     ██╗      ██████╗██╗████████╗║
║  ████╗  ██║██║   ██║██║     ██║     ██╔════╝██║╚══██╔══╝║
║  ██╔██╗ ██║██║   ██║██║     ██║     ██║     ██║   ██║   ║
║  ... (ASCII NULLBIT логотип)                          ║
╠════════════════════════════════════════════════════════╣
║  [ NULLBIT LAUNCHER v2.0 | Cyberpunk Edition ]        ║
╠════════════════════════════════════════════════════════╣

[ SYS ] УСТАНОВКА СОЕДИНЕНИЯ С GITHUB...
[ SYS ] ВЕРСИЯ: 1.0.0

DOWNLOADING [████████████░░░░░░░░] 60% | 420/700 MB

[ ! ] ОБН#РУЖЕНА НОВАЯ СБОРКА
[ ! ] ПЕРЕЗ#ПИСЬ ЯДР#...

[ OK ] ЗАГРУЗКА ЗАВЕРШЕНА
[ OK ] ЯДРО ОБНОВЛЕНО

==================================================
[+] NULLBIT РАБОТАЕТ
    Закройте это окно, чтобы остановить бота
==================================================
```

## Процесс сборки

### Шаги (7 этапов)

1. **Очистка папки Release**
   - Удаление старых файлов
   - Создание временных папок для бота и лаунчера

2. **Сборка bundle через esbuild**
   ```javascript
   esbuild.build({
     entryPoints: ['index.js'],
     bundle: true,
     platform: 'node',
     minify: true,
     external: [], // Встраиваем всё
     outfile: 'bundle.js'
   })
   ```

3. **Подготовка bundle**
   - Копирование (обфускация отключена для больших файлов)

4. **Создание entry point**
   - Встраивание лицензионной проверки
   - Встраивание кода бота как строки

5. **Сборка AIBot.exe через pkg**
   ```bash
   pkg . --targets node18-win-x64 --output AIBot.exe
   ```

6. **Сборка Launcher.exe**
   - Копирование `scripts/launcher.js`
   - Копирование зависимостей (chalk@4, figlet, cli-progress, axios, fs-extra)
   - Сборка через pkg

7. **Cleanup**
   - Создание config.json шаблона (с bot_version)
   - Создание README.txt
   - Удаление временных файлов

## Защита кода

| Уровень | Метод | Эффективность |
|---------|-------|---------------|
| 1 | esbuild bundle | Весь код в одном файле, сложно разобрать |
| 2 | esbuild minify | Нечитаемый код, удалены комментарии |
| 3 | pkg compilation | Код внутри бинарника, требует декомпиляции |
| 4 | KeyAuth license | HWID привязка, онлайн активация |

## Конфигурация

### Где настраивать KeyAuth

**`scripts/build-v2.js`** (функция `generateEntryWithLicense()`):

```javascript
const KEYAUTH_CONFIG = {
  appName: 'Nullbit',
  ownerId: '47IOqyDjNC',
  appSecret: 'daf5f53ecdce23b1872224572b0e1b128288d6fde5ed95b26c07666a5331e6b6',
  version: '1.0'
};
```

### Структура config.json (для пользователя)

```json
{
  "license_key": "YOUR_LICENSE_KEY_HERE",
  "bot_version": "1.0.0",
  "minecraft": {
    "username": "login",
    "password": "pass",
    "host": "mc.server.com",
    "port": 25565,
    "version": "1.20.1"
  },
  "bot": {
    "name": "AI_Bot",
    "language": "ru"
  },
  "features": {
    "pvp": true,
    "voice": true,
    "autoReconnect": true
  }
}
```

## История версий

### v2.1 (2026-05-20) — Cyberpunk Launcher

**Новые фичи:**
- ✅ Cyberpunk-лаунчер с ASCII-логотипом NULLBIT (figlet)
- ✅ Глитч-эффекты в консоли (chalk@4 + случайные спецсимволы)
- ✅ Автообновление через **GitHub Releases API** с прогресс-баром (cli-progress)
- ✅ Хакерский интерфейс: `[ SYS ]`, `[ OK ]`, `[ ERR ]`, `[ WARN ]` статусы
- ✅ Управление процессом — лаунчер остается висеть, убивает бота при закрытии
- ✅ **ПАТЧНОУТ** из `body` GitHub релиза + задержка 2 секунды перед загрузкой
- ✅ Две версии: AIBot.exe (554 MB) + Launcher.exe (58 MB)

**Зависимости лаунчера:**
- `chalk@4.1.2` — цветной вывод (CJS версия для pkg)
- `figlet@1.11.0` — ASCII-арт логотип
- `cli-progress@3.12.0` — прогресс-бар загрузки
- `axios@1.16.1` — HTTP запросы на сервер обновлений
- `fs-extra@11.2.0` — файловые операции

### v2.0 (2026-05-20)

**Проблемы v1.0:**
- `require('./startBot.js')` не находился в pkg snapshot
- Обфускатор падал на 400MB+ файлах
- Сложная файловая структура

**Решения v2.0:**
- ✅ esbuild bundle — все модули в один файл
- ✅ Отказ от тяжелой обфускации, minify достаточно
- ✅ Встроенная KeyAuth сессия (init → license)

### v1.0 (2026-05-20)

- Базовая сборка с файл-за-файл обфускацией
- Проблемы с require() внутри pkg

## Команды

```bash
# Проверка готовности
npm run verify

# Сборка релиза
npm run build
# или
node scripts/build-v2.js
```

## Требования

- Node.js >= 16
- Windows (для сборки .exe)
- Интернет (для проверки лицензии при запуске)

## Распространение

Для конечного пользователя:

**Вариант 1 — Через лаунчер (рекомендуется):**
1. `Launcher.exe` (58 MB) — запускает бота с автообновлением
2. `AIBot.exe` (554 MB) — основной бот
3. `config.json` (заполнить license_key и minecraft данные)
4. Запустить `Launcher.exe`

**Вариант 2 — Напрямую:**
1. `AIBot.exe` (554 MB)
2. `config.json`
3. Запустить `AIBot.exe` (без автообновления)

## Настройка автообновления (GitHub API)

В `scripts/launcher.js` (строка 15):
```javascript
const UPDATE_URL = 'https://api.github.com/repos/nullbit26/Nullbit-Client/releases/latest';
```

**GitHub Releases API возвращает:**
```json
{
  "tag_name": "v1.0.1",
  "body": "Патчноут из дескрипшна релиза",
  "assets": [
    {
      "name": "AIBot.exe",
      "browser_download_url": "https://github.com/nullbit26/Nullbit-Client/releases/download/v1.0.1/AIBot.exe",
      "size": 580000000
    }
  ]
}
```

**Процесс обновления:**
1. Лаунчер читает `bot_version` из `config.json`
2. GET запрос на GitHub API (`User-Agent: Nullbit-Launcher`)
3. Извлекает `tag_name` → стрипает `v` → сравнивает semver
4. При наличии обновления — выводит **ПАТЧНОУТ** (`body` релиза) серым цветом
5. Ждёт 2 секунды (пользователь читает)
6. Скачивает `AIBot.exe` из `assets[]` через `browser_download_url`
7. Создает бэкап, заменяет файл, обновляет `bot_version` в `config.json`

## Связанные документы

- `BUILD_SETUP.md` — Полная инструкция по сборке
- `CHANGELOG.md` — История изменений
- `docs/PVP_FIXES_SUMMARY.md` — Последние фиксы PvP
