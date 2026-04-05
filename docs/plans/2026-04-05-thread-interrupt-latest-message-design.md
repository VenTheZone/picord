# Thread interrupt latest-message design

## Goal
When a user sends a new message in a Discord thread while Picord is still responding, interrupt the current run and immediately process the latest message in the same session.

## Approved behavior
- Interrupt the active run for that thread.
- Do not reset or clear the session.
- Do not post an interruption notice.
- The latest user message wins.
- Stale output from the interrupted run must not continue rendering.

## Approach
Use per-conversation run versioning in the Discord runtime layer:
- track the latest run id per `conversationKey`
- abort active session run before starting a newer one
- only allow live renderer updates/finalization if the run id is still current

## Scope
- `src/pi-session.ts`
- `src/discord-port/discord-bot.ts`
- tests if needed
