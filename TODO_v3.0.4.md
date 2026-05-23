# TODO для v3.0.4 - Продвинутая телеметрия

## ✅ Выполнено в v3.0.3:
- ~~Точки в терминале — реальная логика (старые убираются)~~
- ~~DIAGNOSTICS вкладка в лаунчере~~
- ~~Кнопка STOP BOT фикс~~
- ~~Симметричные статусы OFFLINE~~

---

## 🎯 Приоритет HIGH — JSON вывод из бота

Бот должен печатать JSON для полной работы DIAGNOSTICS:

```javascript
// Tactical Scores (уже есть)
{"type":"scores","threatScore":0.3,"survivalScore":0.1,"resourceScore":0.8}

// Combat Debug — для отображения в COMBAT TELEMETRY
{"type":"combat","mode":"FLEE","targetDist":5.2,"weapon":"sword","lastAction":"blocked:target_behind_wall","status":"ENGAGED"}

// Watchdog — для SYSTEM WATCHDOG
{"type":"watchdog","lastCheck":"16:25:09","lockHolder":"TreeJob","pathStatus":"stuck","status":"ACTIVE"}

// Resource — для EXPEDITION TELEMETRY  
{"type":"resource","trees":12,"ores":3,"fallbacks":2,"dangerStops":1,"status":"GATHERING"}

// User Override — показывать когда ИИ заблокирован
{"type":"override","active":true,"until":"16:26:09","reason":"Manual attack command"}

// Critical Errors — красные глитч-логи
{"type":"error","message":"Deadlock detected: NavigationSystem","timestamp":"16:25:09"}
```

---

## 🔒 v3.0.5 — Усиленная защита (отложено)

**Обфускация:**
- javascript-obfuscator падает с OutOfMemory
- Решение: разделить бандл или VM-based защита

**Checksum проверка:**
- Проверка целостности AIBot.exe при запуске

---

## 📋 Задачи v3.0.4 — ✅ ВЫПОЛНЕНО:
- [x] Добавить JSON вывод в TacticalDecisionEngine
- [x] Добавить JSON вывод в CombatSystem
- [x] Добавить JSON вывод в GlobalWatchdog
- [x] Добавить JSON вывод в ResourceSystem (TreeJob/OreJob)
- [ ] Добавить User Override логирование (отложено — не критично)
- [x] Сборка и тест DIAGNOSTICS

## 🎯 Статус: ЗАВЕРШЕНО — текущая версия Bot v1.0.15 / Launcher v3.0.23
