# Docs Index (Source of Truth Map)

Use this file as the navigation entrypoint for project documentation.

---

## Status legend

- **ACTIVE SOURCE OF TRUTH** — current, normative behavior for an area.
- **ACTIVE (HIGH-LEVEL)** — broad architecture overview; defer details to subsystem docs.
- **HISTORICAL / COMPLETED** — retained context, not the current spec.
- **PLAN / DESIGN** — migration/design notes; may be partially or fully obsolete.

---

## Documents

### 1) Command surface / product behavior

- `docs/COMMAND_SYSTEM_CURRENT.md` — **ACTIVE SOURCE OF TRUTH**
  - parser/registry/dispatch flow
  - permissions (chat/whisper parity)
  - delivery policy
  - command readiness vs combat session lifecycle
  - patrol product surface policy
  - **`attack_direct`** (чат-атака): резолв цели, `COMBAT_BUSY` / `DEFEND_ACTIVE`, override и снятие defend, коды логов, см. §7

- `docs/COMMAND_SYSTEM_AUDIT.md` — **HISTORICAL / COMPLETED**
  - pre-router audit snapshot that motivated Phases A-D.

### 2) Overall architecture and ownership

- `docs/ARCHITECTURE_RU.md` — **ACTIVE (HIGH-LEVEL)**
  - startup composition (`startBot` -> `BotBrain` -> systems)
  - ownership boundaries, event flow, invariants
  - **FLEE / retreat / heal-orchestration (normative): §6.1**
  - references to subsystem source-of-truth docs

### 3) Movement/pathfinder stack

- `docs/PATHFINDER_AND_MOVEMENT.md` — **ACTIVE SOURCE OF TRUTH** (movement/pathfinder area)
  - frozen movement constraints and pathfinder behavior/patched assumptions

### 4) Combat-session refactor notes

- `docs/COMBAT_SESSION_REFACTOR_PLAN.md` — **PLAN / DESIGN**
  - migration-oriented plan document; use for rationale/history, not as the current runtime spec.

---

## Reading order for new contributors

1. `docs/ARCHITECTURE_RU.md`
2. `docs/COMMAND_SYSTEM_CURRENT.md`
3. `docs/PATHFINDER_AND_MOVEMENT.md`
4. `docs/COMMAND_SYSTEM_AUDIT.md` (historical context only)
5. `docs/COMBAT_SESSION_REFACTOR_PLAN.md` (plan/rationale)

При настройке **FLEE / retreat / heal в бою**: **`docs/ARCHITECTURE_RU.md` §6.1** и ключи **`combatFlee*`** в **`config.js`**.
