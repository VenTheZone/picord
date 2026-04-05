# Discord renderer tool layout design

## Goal
Make Picord's Discord output feel more native by separating tool activity from the assistant answer and removing redundant assistant labeling.

## Chosen approach
Option B: separate messages, no response label.

## UX changes
- Tool activity stays in its own message.
- Assistant output stays in its own normal bot message.
- Remove the `🤖 Response` prefix entirely.
- Use a plain text tool status message instead of a large embed-style panel.
- Keep live updates for both tool activity and assistant text.

## Rendering behavior
- While the assistant has not produced text yet, show a simple `_thinking…_` placeholder.
- While tools are running, update one tool message in place with compact status lines.
- When the run finishes, keep the final tool summary in that separate message.
- Render the final assistant output as plain Discord markdown with no extra heading.

## Scope
- `src/live-discord-renderer.ts`
- `src/live-discord-renderer.test.ts`

## Validation
- Update tests to assert the removed response header.
- Keep existing markdown chunking and tool formatting behavior.
