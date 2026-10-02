// Internal: the zustand store behind `session`. Separate so http.ts can report a 401 without a cycle.
import { createStore } from 'zustand/vanilla'
import type { SessionSnapshot } from './types'

export const sessionStore = createStore<SessionSnapshot>(() => ({ status: 'loading' }))
