# Command System: Current Behavior

This note describes the **current** command system after router + combat/session sync.
It is the source of truth for product behavior; `COMMAND_SYSTEM_AUDIT.md` is historical context.

Status: **ACTIVE SOURCE OF TRUTH**.

---

## 1) Permission model (chat + whisper)

Public chat and whisper command control use the same centralized rule:

- helper: `utils/commandChatAccess.js` -> `mayControlBot(username, config, partyIFF)`
- allow if:
  - sender is in PartyIFF (`partyIFF.isPartyUsername`), or
  - sender is in `config.allowedUsers`, or
  - `allowedUsers` is empty (open mode)

No intentional divergence between whisper and chat command permissions.

---

## 2) Alias source of truth

Player-facing command aliases are centralized:

- command aliases/patterns: `commands/commandRegistry.js`
- party/friend prefix aliases: `commands/aliasTable.js`
  - shared by both parser (`commandRegistry`) and PartyIFF command handling (`systems/PartyIFFSystem.js`)

Parser matching is explicit (`normExact` / `rawRegex`) and does not use substring matching as primary detection.

---

## 3) FSM state vs combat session lifecycle

There are two different control signals:

- **BotBrain FSM state** (`CoreStates`):
  - high-level intent mode (`IDLE`, `COMBAT`, `FLEE`, etc.)
  - used by systems like Follow/Defend control flow
  - **FLEE behavior** (phases, heal controller, threat pressure, sticky plan, exit hysteresis) is owned by `CombatSystem` and documented in **`docs/ARCHITECTURE_RU.md` §6.1** (not in this command doc).
- **Combat session lifecycle** (`isCombatSessionActive`, `sessionFlags`):
  - concrete ownership/exclusivity of combat session/pathfinder slot
  - used by command hooks to decide readiness and combat policy

Command pipeline uses session lifecycle for command readiness:

- lifecycle signal: `combat/session/sessionFlags.js` -> `onCombatSessionActiveChanged`
- wait helper: `combat/session/waitCombatInactive.js`
- hook integration: `commands/runCommandHooks.js` + `commands/commandContext.js`

This avoids relying only on BotBrain `STATE_CHANGED` for command readiness.

---

## 4) Patrol surface policy

Patrol remains **AI/intent-driven**, not a direct compact chat command surface in the player router.

- Direct player command router exposes movement/inventory/defend/party/misc commands from registry.
- Patrol behavior is available via higher-level AI/intent flow (`DefendSystem` / defend modules), not by adding an implicit new chat shortcut.

This is intentional product policy to avoid accidental surface expansion.

---

## 5) Delivery policy

Dispatch responses use centralized delivery rules:

- channels: `chat`, `whisper`, `whisperPreferred`
- policy module: `commands/deliveryPolicy.js`
- router: `commands/responseRouter.js`

Current behavior:

- `chat`: always chat
- `whisper`: whisper first, fallback to chat if whisper unavailable/errors
- `whisperPreferred`: whisper first, fallback to chat

---

## 6) events.js scope (command path)

`events.js` is intentionally thin for command flow:

- busy/queue gate
- permission gate
- parse (`parsePlayerMessage`)
- dispatch (`dispatchCommand`)
- AI fallback when parser returns `null`

No command-execution switch/case branches should live in `events.js`.

---

## 7) Chat attack command (`attack_direct`)

Player-facing **direct attack** is a first-class registry command (not AI substring routing).

### 7.1 Source files

| Piece | File |
|-------|------|
| Patterns / aliases | `commands/commandRegistry.js` (`command: 'attack_direct'`, `handlerKey: 'legacy.attackDirect'`) |
| Pre-dispatch combat/defend gate | `commands/runCommandHooks.js` → `applyCombatPolicy` (early branch for `attack_direct` before generic policy matrix) |
| Target resolution (v1) | `commands/resolveAttackTarget.js` |
| Handler (orchestration only) | `commands/handlers/combat.js` |
| Dispatch table | `commands/dispatchCommand.js` (`COMBAT_COMMAND_HANDLERS`) |
| Log codes | `commands/commandLogCodes.js` |
| Bus → `attackEntity` | `systems/CombatSystem.js` (`CombatEvents.ENGAGE_ENTITY`; optional **`entityId`** in payload) |
| Context for policy | `commands/commandContext.js` — `brain`, `getCoreState()` (FLEE), `defend`, `partyIFF` |

**Tests:** `node scripts/unit-resolve-attack-target.js`.

### 7.2 Parse surface (summary)

- **Bare verb (no target):** `атакуй` / `бей` / `attack` → `attackKind: 'bare'` → **`attack_target_required`**.
- **Typed mob / token:** `атакуй <цель>`, `бей <цель>`, `attack <target>` (+ RU mob aliases in resolver).
- **Nearest:** `attack nearest`, `атакуй ближайшего …`, optional mob hint.
- **Quoted PvP target:** `атакуй "Player"`, guillemet quotes.
- **Defend override (stops defend, then attacks):** patterns set `defendOverride: '1'`, including:
  - `бросай защиту и атакуй …` / `снимай защиту и …` / `отмени защиту и …` (RU + quoted / nearest / typed),
  - `drop defend and attack …` / `cancel defend and attack …` (EN),
  - `принудительно атакуй …` / `атакуй принудительно …` / `force attack …` / `attack force …` (mirrored orders where listed in registry).
- **Config:** `config.commandAttackDefendOverrideEnabled` — set **`COMMAND_ATTACK_DEFEND_OVERRIDE=0`** in `.env` to reject all override phrases (defend gate always wins).

### 7.3 Target resolution contract (v1)

In `resolveAttackTarget`:

- **`bot.entities`**, not self, **alive** (`health` absent or `> 0`), within **`commandAttackMaxDistanceBlocks`** (env **`COMMAND_ATTACK_MAX_DIST`**).
- **PartyIFF** `getEffectiveIFF` must be **`HOSTILE`**.
- **Ambiguity:** two or more eligible targets and **|d₁ − d₂| ≤ `commandAttackAmbiguityEpsilonBlocks`** (**`COMMAND_ATTACK_AMBIGUITY_EPS`**) → **`target_ambiguous`**.
- **No match / out of range:** **`target_not_found`** vs **`target_not_visible`** (including nearest-without-hint when no hostiles exist vs hostiles only beyond range).
- **LOS / raycast:** not required in v1.

### 7.4 Policy (`applyCombatPolicy` for `attack_direct`)

1. **`COMBAT_BUSY`** if **`isCombatSessionActive()`** or **`getCoreState() === FLEE`** — user-visible `rejectWithMessage` (no implicit interrupt, no wait-for-combat-end for this command).
2. **`DEFEND_ACTIVE`** if **`defend.isDefendActive()`** and override is not allowed.
3. Else continue to handler.

Generic **`COMMAND_POLICY_MATRIX`** interrupt/wait paths **do not** apply to `attack_direct` (handled only in the early branch).

### 7.5 Handler

1. If **`defendOverride === '1'`** and defend still active → **`defend.stopAllDefend({ silent: true })`**.
2. **`resolveAttackTarget`** → on success **`eventBus.emit(CombatEvents.ENGAGE_ENTITY, { entityName, entityId?, strategy, at })`**.
3. Success log: **`ok`** or **`attack_defend_override`** when defend was actually stopped for this command.

**Invariant:** `events.js` does not emit `CombatEvents` for chat commands; the combat handler does.

---

## 8) Related subsystem docs

- Broad architecture / init / system ownership: `docs/ARCHITECTURE_RU.md`
- Movement/pathfinder frozen stack: `docs/PATHFINDER_AND_MOVEMENT.md`
- Historical command audit (completed): `docs/COMMAND_SYSTEM_AUDIT.md`
