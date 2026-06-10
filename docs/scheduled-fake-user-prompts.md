# Scheduled Fake-User Prompts

This feature lets Codex schedule a future user-like prompt for the same local
thread. It is intended for requests such as:

> Run this experiment, then check in one hour whether training is healthy.

The user does not need to write the exact follow-up prompt or exact fire time.
Codex decides those from the request, usually by following a skill such as a
periodic experiment-monitoring skill, then calls the web-server scheduling API.

## Contract

Actors:

- User: gives a normal instruction that implies delayed follow-up.
- Codex: decides whether a delayed follow-up is needed, chooses `dueAt` or
  `delayMs`, drafts the future prompt, and calls the scheduling API.
- codex-web server: persists the schedule, wakes at the due time, and delivers
  the fake-user prompt to the browser renderer.
- Browser shim: receives the scheduled prompt, queues it on `window`, navigates
  to the target local thread, and exposes an ack function.
- Webview composer patch: consumes the queued prompt in the matching thread and
  submits it through the normal composer submit path with
  `followUpSubmitAction: "steer"`.

## API

Create a scheduled fake-user prompt:

```bash
curl -X POST http://127.0.0.1:8214/__backend/scheduled-fake-user-prompts \
  -H 'content-type: application/json' \
  -d '{
    "delayMs": 3600000,
    "sourcePrompt": "Run this experiment, then check in one hour whether training is healthy.",
    "prompt": "Resume this thread. Check the experiment logs, process/GPU state, checkpoints, and latest metrics. Report whether training is healthy and take the next reasonable action if it is not.",
    "idempotencyKey": "experiment-health-check-2026-06-05T07:00:00Z"
  }'
```

Fields:

- `conversationId`: optional if a `/local/:conversationId` thread is currently
  active in the browser; otherwise required.
- `prompt`: optional. If omitted, the server creates a conservative generic
  follow-up prompt from `sourcePrompt`, `reason`, and `dueAt`.
- `dueAt`, `dueAtMs`, or `delayMs`: optional. If omitted, defaults to one hour.
- `idempotencyKey`: optional caller-chosen key to avoid duplicate schedules.
- `sourcePrompt` and `reason`: optional audit context.

List schedules:

```bash
curl http://127.0.0.1:8214/__backend/scheduled-fake-user-prompts
```

Cancel a schedule:

```bash
curl -X DELETE http://127.0.0.1:8214/__backend/scheduled-fake-user-prompts/<id>
```

## State Machine

`scheduled` means persisted and waiting for dispatch. At the due time, the
server broadcasts it over the existing IPC WebSocket. The browser queues by
`id`, so repeated server retries do not duplicate a prompt.

`dispatching` means the composer in the target thread acknowledged the prompt
and started the normal submit flow. Scheduled fake-user prompts default to
`steer` rather than `queue`; a later API revision can add an explicit
`submitAction` field if callers need to override this.

`sent` means the composer submit promise resolved. `failed` means the renderer
reported a submission error. `cancelled` means the schedule was explicitly
cancelled.

## Skill Guidance

A skill that wants delayed self-follow-up should:

1. Decide whether the user's request implies an out-of-band future check.
2. Pick a concrete schedule time. For "check in one hour", use `delayMs:
3600000`; for absolute times, use ISO `dueAt`.
3. Draft a standalone future prompt. Include what to inspect, what counts as
   healthy, and what action Codex should take if it is unhealthy.
4. Call `POST /__backend/scheduled-fake-user-prompts`.
5. Tell the user the follow-up has been scheduled, including the absolute local
   fire time and a short summary of the future prompt.
