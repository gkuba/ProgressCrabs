// The colour themes. Each key is a role, named after the Dracula colour that
// first filled it:
//   purple  finished steps, the done/total count, "writing"
//   pink    the running step, "thinking"
//   orange  the step up next, "running <tool>", the crab's shell
//   green   all steps done, a finished side session
//   comment the empty track, idle crabs, dim text
//   line    the crab card's fill
//   bg      the crab's eyes and mouth, the "?" on a waiting badge
// To add a theme, add an entry here; `/progress theme` lists it at once.

export type Palette = {
  bg: string
  line: string
  fg: string
  comment: string
  cyan: string
  green: string
  orange: string
  pink: string
  purple: string
  red: string
  yellow: string
  // The crab's shell; the `orange` role when unset.
  crab?: string
}

export const THEMES = {
  dracula: {
    bg: '#282a36', line: '#44475a', fg: '#f8f8f2', comment: '#6272a4', cyan: '#8be9fd', green: '#50fa7b',
    orange: '#ffb86c', pink: '#ff79c6', purple: '#bd93f9', red: '#ff5555', yellow: '#f1fa8c',
  },
  'tokyo-night': {
    bg: '#1a1b26', line: '#292e42', fg: '#c0caf5', comment: '#565f89', cyan: '#7dcfff', green: '#9ece6a',
    orange: '#ff9e64', pink: '#bb9af7', purple: '#7aa2f7', red: '#f7768e', yellow: '#e0af68',
  },
  nord: {
    bg: '#2e3440', line: '#3b4252', fg: '#eceff4', comment: '#4c566a', cyan: '#88c0d0', green: '#a3be8c',
    orange: '#d08770', pink: '#b48ead', purple: '#81a1c1', red: '#bf616a', yellow: '#ebcb8b',
  },
  github: {
    bg: '#0d1117', line: '#21262d', fg: '#e6edf3', comment: '#6e7681', cyan: '#39c5cf', green: '#3fb950',
    orange: '#db6d28', pink: '#db61a2', purple: '#a371f7', red: '#f85149', yellow: '#d29922',
  },
  'github-light': {
    bg: '#ffffff', line: '#eaeef2', fg: '#1f2328', comment: '#8c959f', cyan: '#1b7c83', green: '#1a7f37',
    orange: '#bc4c00', pink: '#bf3989', purple: '#8250df', red: '#cf222e', yellow: '#9a6700',
  },
  gruvbox: {
    bg: '#282828', line: '#3c3836', fg: '#ebdbb2', comment: '#928374', cyan: '#8ec07c', green: '#b8bb26',
    orange: '#fe8019', pink: '#d3869b', purple: '#83a598', red: '#fb4934', yellow: '#fabd2f',
  },
  'one-dark': {
    bg: '#282c34', line: '#3e4451', fg: '#abb2bf', comment: '#5c6370', cyan: '#56b6c2', green: '#98c379',
    orange: '#d19a66', pink: '#c678dd', purple: '#61afef', red: '#e06c75', yellow: '#e5c07b',
  },
  'catppuccin-latte': {
    bg: '#eff1f5', line: '#ccd0da', fg: '#4c4f69', comment: '#9ca0b0', cyan: '#04a5e5', green: '#40a02b',
    orange: '#fe640b', pink: '#ea76cb', purple: '#8839ef', red: '#d20f39', yellow: '#df8e1d',
  },
  'catppuccin-frappe': {
    bg: '#303446', line: '#414559', fg: '#c6d0f5', comment: '#737994', cyan: '#99d1db', green: '#a6d189',
    orange: '#ef9f76', pink: '#f4b8e4', purple: '#ca9ee6', red: '#e78284', yellow: '#e5c890',
  },
  'catppuccin-macchiato': {
    bg: '#24273a', line: '#363a4f', fg: '#cad3f5', comment: '#6e738d', cyan: '#91d7e3', green: '#a6da95',
    orange: '#f5a97f', pink: '#f5bde6', purple: '#c6a0f6', red: '#ed8796', yellow: '#eed49f',
  },
  'catppuccin-mocha': {
    bg: '#1e1e2e', line: '#313244', fg: '#cdd6f4', comment: '#6c7086', cyan: '#89dceb', green: '#a6e3a1',
    orange: '#fab387', pink: '#f5c2e7', purple: '#cba6f7', red: '#f38ba8', yellow: '#f9e2af',
  },
} satisfies Record<string, Palette>

export type ThemeName = keyof typeof THEMES

export const DEFAULT_THEME: ThemeName = 'dracula'

export const isTheme = (name: unknown): name is ThemeName => typeof name === 'string' && name in THEMES

// The settings' colour fields, laid over the theme. A blank or malformed hex is ignored.
export type Overrides = { done?: string; current?: string; next?: string; crab?: string }

const hex = (s: unknown) => (typeof s === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.trim()) ? s.trim() : undefined)

export const paletteOf = (name: unknown, over: Overrides = {}): Palette => {
  const base: Palette = THEMES[isTheme(name) ? name : DEFAULT_THEME]

  return {
    ...base,
    purple: hex(over.done) ?? base.purple,
    pink: hex(over.current) ?? base.pink,
    orange: hex(over.next) ?? base.orange,
    crab: hex(over.crab) ?? base.crab,
  }
}
