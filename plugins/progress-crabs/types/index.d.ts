export type Step = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt?: number
  finishedAt?: number
}
// A linked session: the app's state word, and what the panel adds to it.
// isListed: read from list_sessions, not the note; isParent: the session that started this chat.
export type Side = { name: string; id: string; state: string; title?: string; step?: string; since?: number; isListed?: boolean; isParent?: boolean }
// What the main loop is doing during a turn, and when the turn began.
export type Activity = { mode: 'thinking' | 'writing' | 'tool'; tool?: string; since: number }
// A progress bar a helper reports from its shell; isOver: `done` or `fail` was reported.
export type HelperBar = { name: string; done: number; total?: number; isPercent?: boolean; isOver?: boolean; isFailed?: boolean }
// A subagent this chat started: what it is, what it is doing, and its latest bar.
export type Helper = {
  id: string
  description: string
  type: string
  parentId?: string
  status: 'working' | 'done' | 'failed'
  tool?: string
  calls: number
  startedAt: number
  finishedAt?: number
  bar?: HelperBar
}

declare module 'claude-code' {
  interface PluginState {
    'progress-crabs': {
      steps: Shaped<Step[]>
      theme: string | null
      sides: Shaped<Side[]>
      activity: Shaped<Activity | null>
      helpers: Shaped<Helper[]>
      now: number
      isHidden: boolean
      isPaneDismissed: boolean
      // A background read of the session tools waits on the person's allow.
      needsAllow: boolean
      // Turns started since the task list last changed.
      planAge: number
      // A turn was stopped with a step running.
      isInterrupted: boolean
    }
  }
}
