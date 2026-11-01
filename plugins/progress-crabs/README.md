# progress-crabs

```
/plugin install progress-crabs --marketplace gkuba/ProgressCrabs
```

A compact band above the prompt that shows where a long chat stands:

- **Task bar**: the chat's task list as a full-width pill in the current theme on its own row (purple = done, pink = in progress, orange = up next, slate = rest; block characters in a terminal: `█` done, `▓` running, `▒` next, `░` rest), `done/total`, the current step and its times, on the row below. Short of rows or narrower than 40 cells, it folds into one row: a small bar, the count, a dot for Claude and `🦀N` for the side sessions (in the colour of the one that needs you most), then the step. A finished list flashes once, turns green and says `✓ all steps done in 12m` until the next turn. A turn stopped mid-step marks it `⏸ … · interrupted` until the next update. A list no update touched for 3 turns dims and says `/progress clear hides it`.
- **Working**: while Claude works, a dot and what it is doing with the turn's time so far: `thinking · 42s` (pink), `running Bash · 1m` (orange), `writing · 2m` (purple). Shows in any chat, task list or not.
- **Time**: how long the current step has run, and `~Nm left`: the finished steps' times, the latest weighing most, times what is left. Shown once two steps have finished, and hidden while their times vary too much to guess from; redraws every 5 seconds.
- **Sessions**: each linked side session with a coloured dot and its state (working, idle, waiting...), read from the app's "Linked sessions now" note.

It reads the desktop app's task-list tool (`mcp__ccd_turn__update_plan` / `wrap_up`) as it runs, so it updates live; after a restart or resume it rebuilds the list from the transcript's own calls. The theme's colours sit on a semi-transparent track, so it reads in light and dark themes; on the light themes every colour keeps 3:1 contrast or better.

## Crab Tasks pane

`details ↗` on the band, or `/progress list`, opens a **Crab Tasks** tab beside the other mods' panes: `done/total`, elapsed, `~left` and `interrupted` up top, then one bar per step in the theme's colours, then the side sessions (below). Done steps are purple (all green once the list finishes), the next one orange, the rest an empty track. The running step cools like hot metal: an orange leading edge fading through pink to purple behind it, filling with its time against the usual step's; past that it holds at 90% with a pulsing hot edge. Before there is an estimate it eases toward the finished steps' average (or 90s), slowing as it nears 90%, so it only ever moves forward. A step that finishes flashes green, then settles. Desktop draws SVG gradients; a terminal colours each cell.

## Side sessions

Below the step bars in Crab Tasks (on their own when there is no task list), one card per side session started from this chat, sessions that need you first (with a bolder outline), then working ones, then the rest: a pixel crab, the session's title, its state and how long it has been in it, and the first line of its latest answer. The crab walks while the session works, raises its claws with a pink `?` and says `needs you` when it waits on you, shows a green check when done, and sits grey when idle (no motion under reduced-motion settings). A toast pops when a session finishes a turn or starts waiting. `Open … ↗` under a card switches to that session. In a side session the chat that started it gets a card too, marked `↑` when the app's list makes it certain, its state read every 10 seconds while any of the family works and every minute while all sit idle. Idle times count from the session's last activity, and archived sessions drop off. Crab Tasks opens by itself the first time a side session appears; `/crabs` (or `/progress list`) shows or hides it; closed by hand, it stays closed until you open it again. Its background reads never put a permission dialog up: when your permission mode would ask, the pane shows an **Allow session tools** button (or run `/crabs`). Crab animation approach after savvy-progress (MIT); the sprite is this mod's own.

## Themes

`/progress theme` lists the themes and opens a **Themes** panel showing each one's colours, where a click switches (themes: Dracula default, Tokyo Night, Nord, GitHub, GitHub Light, Gruvbox, One Dark, Catppuccin Latte/Frappé/Macchiato/Mocha); `/progress theme <name>` switches and saves it; `/progress theme default` goes back to the settings, and so does changing the settings' theme. Settings (`/plugin configure progress-crabs@progress-crabs`): a theme picker plus optional hex colours for done, current, next and the crab. Palettes live in `hooks/themes.ts`.

## Toggle

- `/progress` hides or shows the band for the session; `/progress show` / `/progress hide` set it; `/progress list` opens or closes the Crab Tasks pane; `/progress clear` drops a task list left behind (one not updated for 3 turns draws dimmed).
- The band's own `[-]` (or ctrl+x ctrl+a) collapses it.
- To turn it off everywhere: `claude plugin disable progress-crabs@progress-crabs`; to remove it: `claude plugin uninstall progress-crabs@progress-crabs`.
