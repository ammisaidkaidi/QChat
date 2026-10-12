---
name: screenshot-capture
description: Capture a web page or the desktop and report where the image was saved.
when: The user asks for a screenshot, a capture, or "show me" a page.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Screenshot capture

1. A page: `screen_shot` with `{"url":"<address>","full":true}`. The desktop:
   no `url` (needs a display; without one the script says so — report that).
2. Pass `name` when the user named the shot (`"homepage"`), otherwise keep the
   timestamp the script chooses.
3. The image lands in `./screenshot/`, or in the `out` folder you passed; leave
   `keep` at its default.
4. Answer with the saved path exactly as the tool reported it — never claim a
   capture you did not take.
5. Do not describe what the image shows unless the user asks.
