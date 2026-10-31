// The linked-sessions panel's drawings: one SVG card per side session, with a
// pixel crab that walks while the session works. The approach (a CSS-animated
// sprite inside an SVG, stilled under prefers-reduced-motion) follows the
// savvy-progress mod; the sprite and markup here are this mod's own.

export const D = {
  bg: '#282a36',
  line: '#44475a',
  fg: '#f8f8f2',
  comment: '#6272a4',
  cyan: '#8be9fd',
  green: '#50fa7b',
  orange: '#ffb86c',
  pink: '#ff79c6',
  purple: '#bd93f9',
  red: '#ff5555',
  yellow: '#f1fa8c',
}

export type Mood = 'working' | 'waiting' | 'done' | 'idle'

export const moodOf = (state: string): Mood =>
  /wait|block|ask|input/.test(state)
    ? 'waiting'
    : /work|start|run/.test(state)
      ? 'working'
      : /done|complete|finish/.test(state)
        ? 'done'
        : 'idle'

export const MOOD = {
  working: { label: 'working', color: D.orange },
  waiting: { label: 'waiting on you', color: D.pink },
  done: { label: 'done', color: D.green },
  idle: { label: 'idle', color: D.comment },
} as const

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Legs step in two pairs and the body bobs; all compositor-run CSS, so a
// working crab moves without the mod redrawing it.
const CSS = `<style>
.walk .la{animation:st .5s steps(1) infinite}.walk .lb{animation:st .5s steps(1) infinite -.25s}
.walk .bd{animation:bob .5s steps(1) infinite -.125s}
.wave .cl{animation:wv 1s steps(1) infinite}
.live{animation:pl 1.6s ease-in-out infinite}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@keyframes wv{50%{transform:translateY(1px)}}@keyframes pl{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.walk *,.wave *,.live{animation:none!important}}
</style>`

const px = (x: number, y: number, w: number, h: number, c: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`

// A 20×14 pixel crab. Waiting raises both claws; done and idle sit still.
export const crab = (x: number, y: number, mood: Mood, scale = 2) => {
  const shell = mood === 'idle' ? D.comment : D.orange
  const claws =
    mood === 'waiting'
      ? px(0, 0, 3, 3, shell) + px(1, 3, 1, 3, shell) + px(17, 0, 3, 3, shell) + px(18, 3, 1, 3, shell)
      : px(0, 6, 3, 3, shell) + px(3, 7, 1, 1, shell) + px(17, 6, 3, 3, shell) + px(16, 7, 1, 1, shell)
  const body =
    px(4, 4, 12, 7, shell) +
    px(6, 2, 1, 2, shell) +
    px(13, 2, 1, 2, shell) +
    px(6, 1, 2, 2, D.bg) +
    px(12, 1, 2, 2, D.bg) +
    px(8, 8, 4, 1, D.bg)
  const legs = (cls: string, a: number, b: number) => `<g class="${cls}">${px(a, 11, 1, 3, shell)}${px(b, 11, 1, 3, shell)}</g>`
  const motion = mood === 'working' ? 'walk' : mood === 'waiting' ? 'wave' : ''

  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="${motion}"><g class="bd">${body}<g class="cl">${claws}</g></g>${legs('la', 4, 12)}${legs('lb', 7, 15)}</g></g>`
}

// The state mark beside the crab: a pulsing dot, a "?" bubble, a check, or a ring.
const badge = (x: number, y: number, mood: Mood) => {
  const c = MOOD[mood].color
  if (mood === 'working') return `<circle class="live" cx="${x}" cy="${y}" r="4" fill="${c}"/>`
  if (mood === 'waiting')
    return `<circle cx="${x}" cy="${y}" r="6" fill="${c}"/><text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${D.bg}" font-family="sans-serif">?</text>`
  if (mood === 'done')
    return `<path d="M${x - 4} ${y}l3 3 5-6" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

  return `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${c}" stroke-width="1.5"/>`
}

export const CARD_H = 56

export type Card = { title: string; mood: Mood; step?: string; elapsed?: string }

// One card: crab on the left, title, state and time, then the latest step.
export const cardSvg = (W: number, c: Card) => {
  const m = MOOD[c.mood]
  const chars = Math.max(12, Math.floor((W - 70) / 7))
  const state = [m.label, c.elapsed].filter(Boolean).join(' · ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CARD_H}" viewBox="0 0 ${W} ${CARD_H}">${CSS}
<rect x="0.5" y="0.5" width="${W - 1}" height="${CARD_H - 1}" rx="10" fill="${D.line}" fill-opacity="0.35" stroke="${m.color}" stroke-opacity="0.6"/>
${crab(10, 14, c.mood)}${badge(50, 12, c.mood)}
<g font-family="sans-serif" font-size="12">
<text x="62" y="20" font-weight="600" fill="${D.purple}">${esc(clip(c.title, chars))}</text>
<text x="62" y="35" fill="${m.color}">${esc(state)}</text>
<text x="62" y="49" fill="${D.comment}">${esc(clip(c.step ?? '', chars + 4))}</text>
</g></svg>`
}
