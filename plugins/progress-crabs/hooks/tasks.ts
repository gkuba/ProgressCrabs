// The task pane's per-step bars: done steps solid, the next one orange, the
// rest an empty track, and the running one cooling like hot metal, its
// leading edge orange and the older fill fading through pink to purple.

import type { Step } from '../types'
import type { Palette } from './themes'

// How long a step's bar, or the band's, flashes green once it finishes.
export const FLASH_MS = 1_500
// A step that runs past its estimate fills to here and pulses at the edge.
export const MAX_FILL = 0.9

export type Look = 'done' | 'flash' | 'running' | 'next' | 'rest'

export type StepBar = {
  look: Look
  // Share of the bar the running step fills; null while no estimate exists.
  fill: number | null
  isOver: boolean
}

export const stepBars = (list: Step[], now: number, estimate: number | null): StepBar[] => {
  const nextAt = list.findIndex(step => step.status === 'pending')
  const isRunning = list.some(step => step.status === 'in_progress')

  return list.map((step, i) => {
    if (step.status === 'completed') {
      const isFresh = step.finishedAt !== undefined && now - step.finishedAt < FLASH_MS
      return { look: isFresh ? 'flash' : 'done', fill: 1, isOver: false }
    }
    if (step.status === 'in_progress') {
      const spent = step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0
      if (!estimate) return { look: 'running', fill: null, isOver: false }

      return { look: 'running', fill: Math.max(0.04, Math.min(MAX_FILL, spent / estimate)), isOver: spent >= estimate }
    }

    return { look: isRunning && i === nextAt ? 'next' : 'rest', fill: i === nextAt && isRunning ? 1 : 0, isOver: false }
  })
}

const HEX = /^#([0-9a-f]{6})$/i

// A colour t of the way from a to b; a named colour cannot be blended, so it steps.
export const mix = (a: string, b: string, t: number) => {
  const [ma, mb] = [HEX.exec(a), HEX.exec(b)]
  if (!ma || !mb) return t < 0.5 ? a : b
  const [x, y] = [parseInt(ma[1] as string, 16), parseInt(mb[1] as string, 16)]
  const channel = (shift: number) => Math.round(((x >> shift) & 255) * (1 - t) + ((y >> shift) & 255) * t)

  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`
}

// Cold to hot: purple at the start of the fill, pink midway, orange at the edge.
export const heat = (P: Palette, t: number) => (t < 0.5 ? mix(P.purple, P.pink, t * 2) : mix(P.pink, P.orange, (t - 0.5) * 2))

export const BAR_H = 8

export const stepSvg = (P: Palette, bar: StepBar, doneColor: string, id: number) => {
  const r = BAR_H / 2
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`
  const track = `<rect x="0" y="0" width="100%" height="${BAR_H}" rx="${r}" fill="${P.comment}" fill-opacity="0.3"/>`
  const svg = (body: string, style = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAR_H}">${style ? `<style>${style}@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>` : ''}${track}${body}</svg>`
  const solid = (fill: string, cls = '') => `<rect${cls ? ` class="${cls}"` : ''} x="0" y="0" width="100%" height="${BAR_H}" rx="${r}" fill="${fill}"/>`

  if (bar.look === 'done') return svg(solid(doneColor))
  if (bar.look === 'flash') return svg(solid(doneColor, 'f'), `@keyframes f{from{fill:${P.green}}to{fill:${doneColor}}}.f{animation:f ${FLASH_MS}ms ease-out forwards}`)
  if (bar.look === 'next') return svg(solid(P.orange))
  if (bar.look === 'rest') return svg('')
  if (bar.fill === null) {
    // No estimate yet: a pink stripe sweeps the track.
    return svg(
      `<rect class="s" x="-25%" y="0" width="25%" height="${BAR_H}" rx="${r}" fill="${P.pink}"/>`,
      '@keyframes s{from{x:-25%}to{x:100%}}.s{animation:s 1.8s linear infinite}',
    )
  }
  const g = `heat${id}`
  const edge = Math.max(0, bar.fill - 0.03)

  return svg(
    `<defs><linearGradient id="${g}" x1="0" x2="1"><stop offset="0" stop-color="${P.purple}"/><stop offset="0.55" stop-color="${P.pink}"/><stop offset="1" stop-color="${P.orange}"/></linearGradient></defs>
<rect x="0" y="0" width="${pct(bar.fill)}" height="${BAR_H}" rx="${r}" fill="url(#${g})"/>
${bar.isOver ? `<rect class="h" x="${pct(edge)}" y="0" width="${pct(bar.fill - edge)}" height="${BAR_H}" rx="${r}" fill="${P.orange}"/>` : ''}`,
    bar.isOver ? '@keyframes h{50%{opacity:.2}}.h{animation:h 1s ease-in-out infinite}' : '',
  )
}

export type Cell = { glyph: string; color: string }

// The terminal's bar: one coloured cell each, the clock's tick standing in
// for animation (the stripe steps along, the hot edge blinks).
export const stepCells = (P: Palette, bar: StepBar, doneColor: string, cells: number, tick: number): Cell[] => {
  const empty: Cell = { glyph: '░', color: P.comment }
  const all = (cell: Cell) => Array.from({ length: cells }, () => cell)
  if (bar.look === 'done') return all({ glyph: '█', color: doneColor })
  if (bar.look === 'flash') return all({ glyph: '█', color: P.green })
  if (bar.look === 'next') return all({ glyph: '▒', color: P.orange })
  if (bar.look === 'rest') return all(empty)
  if (bar.fill === null) {
    const at = (tick * 3) % cells

    return Array.from({ length: cells }, (_, i) => (i >= at && i < at + 3 ? { glyph: '▓', color: P.pink } : empty))
  }
  const filled = Math.max(1, Math.round(bar.fill * cells))

  return Array.from({ length: cells }, (_, i) => {
    if (i >= filled) return empty
    const isEdge = i === filled - 1
    if (isEdge && bar.isOver && tick % 2 === 1) return { glyph: '▓', color: P.orange }

    return { glyph: '█', color: heat(P, filled === 1 ? 1 : i / (filled - 1)) }
  })
}

// Runs of one colour drawn as one Text each.
export const runsOf = (cells: Cell[]) =>
  cells.reduce<Cell[]>((runs, cell) => {
    const last = runs.at(-1)
    if (last && last.color === cell.color) last.glyph += cell.glyph
    else runs.push({ ...cell })
    return runs
  }, [])
