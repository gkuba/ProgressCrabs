# progress-crabs

```
/plugin install progress-crabs --marketplace gkuba/ProgressCrabs
```

A compact band above the prompt that shows where a long chat stands:

- **Task bar**: the chat's task list as a full-width pill in the current theme on its own row (purple = done, pink = in progress, orange = up next, slate = rest; block characters in a terminal: `█` done, `▓` running, `▒` next, `░` rest), `done/total`, the current step and its times, on the row below.
- **Working**: while Claude works, a dot and what it is doing with the turn's time so far: `thinking · 42s` (pink), `running Bash · 1m` (orange), `writing · 2m` (purple). Shows in any chat, task list or not.
- **Time**: how long the current step has run, and `~Nm left (rough)`: the average time of the finished steps times what is left. Shown once a step has finished; redraws every 5 seconds.
- **Sessions**: each linked side session with a coloured dot and its state (working, idle, waiting...), read from the app's "Linked sessions now" note.

It reads the desktop app's task-list tool (`mcp__ccd_turn__update_plan` / `wrap_up`) as it runs, so it updates live. The theme's colours sit on a semi-transparent track, so it reads in light and dark themes.

## Side sessions panel

A pane with one card per side session started from this chat: a pixel crab, the session's title, its state and how long it has been in it, and the first line of its latest answer. The crab walks while the session works, raises its claws with a pink `?` when it waits on you, shows a green check when done, and sits grey when idle (no motion under reduced-motion settings). A toast pops when a session finishes a turn or starts waiting. `Open … ↗` under a card switches to that session. In a side session the chat that started it gets a card too, marked `↑` when the app's list makes it certain, its state read every 30 seconds. Idle times count from the session's last activity, and archived sessions drop off. It opens by itself the first time a side session appears; `/crabs` shows or hides it; closed by hand, it stays closed until `/crabs`. Its background reads never put a permission dialog up: when your permission mode would ask, the panel shows an **Allow session tools** button (or run `/crabs`). Crab animation approach after savvy-progress (MIT); the sprite is this mod's own.

## Themes

`/progress theme` lists the themes (Dracula default, Tokyo Night, Nord, GitHub, GitHub Light, Gruvbox, One Dark, Catppuccin Latte/Frappé/Macchiato/Mocha); `/progress theme <name>` switches and saves it; `/progress theme default` goes back to the settings, and so does changing the settings' theme. Settings (`/plugin configure progress-crabs@progress-crabs`): a theme picker plus optional hex colours for done, current, next and the crab. Palettes live in `hooks/themes.ts`.

## Toggle

- `/progress` hides or shows the band for the session; `/progress show` / `/progress hide` set it; `/progress clear` drops a task list left behind (one not updated for 3 turns draws dimmed).
- The band's own `[-]` (or ctrl+x ctrl+a) collapses it.
- To turn it off everywhere: `claude plugin disable progress-crabs@progress-crabs`; to remove it: `claude plugin uninstall progress-crabs@progress-crabs`.
