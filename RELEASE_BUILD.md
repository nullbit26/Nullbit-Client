# Release Build System v2.0

## Overview

Система сборки релиза AI Bot для распространения в виде Windows .exe файла с лицензионной защитой KeyAuth.

**Статус:** ✅ Активно используется  
**Дата:** 2026-05-20  
**Версия:** v2.0 (esbuild bundle)

## Архитектура

### Компоненты сборки

```
┌─────────────────────────────────────────────────────────────┐
│  Исходный код проекта (index.js, systems/, core/, etc.)     │
└─────────────────────────────────────────────────────────────┘
                           ↓
                    esbuild bundle
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  Single bundle.js (все модули встроены)                    │
│  - Обработка всех require()                                  │
│  - Минификация кода                                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
              Встраивание лицензии + pkg
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  AIBot.exe (705 MB)                                        │
│  - KeyAuth проверка при запуске                            │
│  - HWID привязка                                           │
│  - Весь код внутри бинарника                               │
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
| `scripts/build-v2.js` | Основной скрипт сборки (6 шагов) |
| `scripts/verify-build.js` | Проверка готовности к сборке |
| `scripts/license-check.js` | Модуль проверки лицензии (для разработки) |
| `BUILD_SETUP.md` | Полная инструкция по сборке |

## Процесс сборки

### Шаги (6 этапов)

1. **Очистка папки Release**
   - Удаление старых файлов
   - Создание временной папки

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

5. **Сборка .exe через pkg**
   ```bash
   pkg . --targets node18-win-x64 --output AIBot.exe
   ```

6. **Cleanup**
   - Создание config.json шаблона
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
1. `AIBot.exe` (705 MB)
2. `config.json` (заполнить license_key и minecraft данные)
3. Запустить exe

## Связанные документы

- `BUILD_SETUP.md` — Полная инструкция по сборке
- `CHANGELOG.md` — История изменений
- `docs/PVP_FIXES_SUMMARY.md` — Последние фиксы PvP
