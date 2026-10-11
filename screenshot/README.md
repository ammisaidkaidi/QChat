# `screenshot/`

Pictures taken by the **`screen_shot`** script (`scripts/screen_shot.js`), one PNG
per capture, named `shot-<UTC timestamp>.png` unless a `name` is given.

```bash
# the desktop (X11 or Wayland)
node scripts/screen_shot.js '{}'

# a web page, through a headless browser (works with no display at all)
node scripts/screen_shot.js '{"url":"http://127.0.0.1:8787","name":"console.png"}'

# same thing through the toolbox, REST or the model
infagent scripts run screen_shot '{"url":"http://127.0.0.1:8787"}'
infagent chat ask "take a screenshot of the console at http://127.0.0.1:8787"
```

`backend` in the result says how the picture was taken:

| backend | when |
| --- | --- |
| `x11` | `$DISPLAY` set — `scrot`, or ImageMagick `import -window root` |
| `wayland` | `$WAYLAND_DISPLAY` set — `grim` |
| `xvfb` | no display at all — a virtual screen, so the image is blank |
| `web` | a `url` was passed — headless Chromium screenshot of that page |

Arguments: `out` (default `screenshot/`), `name`, `url`, `full`, `width`,
`height`, `display`, and `keep` — how many recent PNGs stay in the folder
(default 20, `0` keeps everything). Older files are pruned after each capture,
so a cron job or a skill that shoots every hour cannot fill the disk.
