# Heartbeat Automations

codex-web uses the upstream Codex Desktop automation implementation instead of
a local fake-user prompt scheduler.

Heartbeat automations are stored by the upstream app under:

```text
$CODEX_HOME/automations/<automation_id>/automation.toml
```

The relevant TOML fields match upstream Codex Desktop:

```toml
version = 1
id = "automation-id"
kind = "heartbeat"
name = "Automation name"
prompt = "What the heartbeat should check"
status = "ACTIVE"
rrule = "FREQ=MINUTELY;INTERVAL=30"
target_thread_id = "thread-id"
created_at = 1760000000000
updated_at = 1760000000000
```

Runtime behavior:

- The upstream main bundle owns automation persistence, scheduling, duplicate
  heartbeat detection, and `resumeThread` / `startTurn`.
- The browser shim forwards upstream Electron IPC over the codex-web websocket
  bridge.
- The shim forces the upstream heartbeat automation Statsig gate on. Upstream
  renderer code then reports both `heartbeat-automations-enabled-changed` and
  `heartbeat-automation-thread-state-changed` through the normal Electron IPC
  bridge, enabling the scheduler and keeping thread eligibility, collaboration
  mode, and permission state current.

The previous codex-web-only scheduled fake-user prompt API and composer patch
were removed. Do not reintroduce `__backend/scheduled-fake-user-prompts` for
recurring thread wakeups; use upstream automations instead.
