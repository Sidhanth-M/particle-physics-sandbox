# Particle Physics Sandbox

A falling-sand toy where every material reads the same temperature field and the same
charge field. Lava burns wood because it is hot. Every ignition on the grid runs through
that one number.

Drop water on molten silicate and it quenches into obsidian. Let the same melt cool on
its own and you get glass. More than 30 materials share those two fields, so behaviour
like that falls out of the physics instead of being written per pair.

No build step and no dependencies.

## Running it

```
python serve.py 8011
```

Then open <http://localhost:8011>.

Any static file server works. `serve.py` exists only to disable caching, because
Python's stock `http.server` sends `Last-Modified` with no `Cache-Control`, so a browser
keeps serving a stale module after you edit it.

## Controls

| Key | Action |
|---|---|
| `1`–`9` | Pick a material |
| `0` | Eraser |
| `Q` / `E` | Cycle tool |
| `[` / `]` | Brush size |
| `Space` | Pause |
| `.` | Step one frame while paused |
| `X` / `Y` | Mirror the brush horizontally or vertically |
| `Z` / `R` | Undo, redo (`Ctrl+Z` and `Ctrl+Shift+Z` also work) |
| `C` | Clear |
| `F` | Fullscreen |
| `?` | Open the material codex |

## How it works

The grid runs at 480x300, locked to an 8:5 aspect. Cells are grouped into chunks, and a
chunk with nothing moving inside it is skipped for that frame, so a settled pile costs
close to nothing. Horizontal scan direction flips every frame, which stops material
drifting sideways from update order alone.

Rendering goes through WebGL2. Debug views draw the heat field, the charge field,
density, and which chunks are currently awake.

The source is 17 ES modules, around 228 KB of JavaScript, loaded straight by the browser
with no bundler in between.
