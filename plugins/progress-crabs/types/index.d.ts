export type Step = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt?: number
  finishedAt?: number
}
// A linked side session: the app's state word, and what the panel adds to it.
export type Side = { name: string; id: string; state: string; title?: string; step?: string; since?: number }
// What the main loop is doing during a turn, and when the turn began.
export type Activity = { mode: 'thinking' | 'writing' | 'tool'; tool?: string; since: number }

declare module 'claude-code' {
  interface PluginState {
    'progress-crabs': {
      steps: Shaped<Step[]>
      sides: Shaped<Side[]>
      activity: Shaped<Activity | null>
      now: number
      isHidden: boolean
    }
  }
}
