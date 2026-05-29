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

- `docs/MOVEMENT_CONTROLLER_PRODUCTION.md` — **ACTIVE SOURCE OF TRUTH** (Phase 4)
  - centralized movement arbitration with priority queue
  - 5 priority levels (CRITICAL → IDLE)
  - 7 systems integrated: AntiDrown, PvPMode, RespawnRecovery, Combat, OreJob, HomeBase, Follow
  - 122/122 tests passing, 5/5 live Minecraft tests passed
  - feature flags, monitoring dashboard, telemetry

- `docs/MOVEMENT_CONTROLLER_PLAN.md` — **PLAN / DESIGN**
  - implementation roadmap and architecture decisions

- `docs/AI_MC_INTEGRATION.md` — **ACTIVE IMPLEMENTATION**
  - AIIntentSystem + MovementController integration
  - 2 hours implementation vs 5 days original plan
  - Uses existing OpenAI Assistants API infrastructure

- `docs/PROJECT_STATUS.md` — **ACTIVE (PROJECT OVERVIEW)**
  - Complete project status with all phases
  - GitHub readiness checklist

- Root `CHANGELOG.md` — **HISTORY** (project root)
  - Version history from v1.x to current (1181 lines)
  - All major features and changes

- Root `ROADMAP_SUMMARY.md` — **PLANNING** (project root)
  - Future roadmap and evolution plans

### 4) Phase 3: Pathfinder V2.0 & Semantic Layer

- `docs/BLOCK_CLASSIFIER.md` — **ACTIVE SOURCE OF TRUTH**
  - Semantic block classification (10 categories)
  - 26/26 tests passing, production ready

- `docs/STRUCTURE_DETECTOR.md` — **ACTIVE SOURCE OF TRUTH**
  - Pattern recognition for buildings, caves, bridges, roads, farms
  - 26/26 tests passing, production ready

- `docs/ANTISTUCK_V2.md` — **ACTIVE SOURCE OF TRUTH**
  - Advanced unstuck system (85%+ success rate)
  - 53 tests passing, approved by BIG_KOSHAK13

- `docs/PHASE3_SEMANTIC_LAYER_PLAN.md` — **PLAN / DESIGN**
  - BlockClassifier, StructureDetector, TerrainAnalyzer architecture

- `docs/PHASE3_PROBABILISTIC_RISK_PLAN.md` — **PLAN / DESIGN**
  - Risk-aware pathfinding design

- `docs/PHASE3_TEST_RESULTS.md` — **COMPLETED**
  - Test results for Phase 3 components

- `docs/PHASE3_INTEGRATION_TESTING_REPORT.md` — **COMPLETED**
  - Integration testing results

### 5) Historical & Reference

- `docs/COMBAT_SESSION_REFACTOR_PLAN.md` — **PLAN / DESIGN**
  - migration-oriented plan document; use for rationale/history, not as the current runtime spec.

- `docs/COMMAND_SYSTEM_AUDIT.md` — **HISTORICAL / COMPLETED**
  - pre-router audit snapshot that motivated Phases A-D.

---

## Reading order for new contributors

1. Root `README.md` — Project overview and features
2. `docs/PROJECT_STATUS.md` — Current status and phases
3. Root `CHANGELOG.md` — What's been built (recent: Phase 3, MovementController)
4. Root `ROADMAP_SUMMARY.md` — Where we're going
5. `docs/ARCHITECTURE_RU.md` — System architecture
6. `docs/COMMAND_SYSTEM_CURRENT.md` — Command surface
7. `docs/MOVEMENT_CONTROLLER_PRODUCTION.md` — Current movement system (Phase 4)
8. `docs/AI_MC_INTEGRATION.md` — Latest AI integration
9. `docs/PATHFINDER_AND_MOVEMENT.md` — Navigation overview

При настройке **FLEE / retreat / heal в бою**: **`docs/ARCHITECTURE_RU.md` §6.1** и ключи **`combatFlee*`** в **`config.js`**.
