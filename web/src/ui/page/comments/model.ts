import type { Member } from '../../../lib'

/**
 * Who may be mentioned in a Comment: Members and Admins (never a Guest, who cannot read Comments). In a Local
 * Workspace only oneself — its other Members, if a Team file brought any, are names that cannot read anything.
 */
export function mentionable(list: readonly Member[], me: Member, local: boolean): Member[] {
  if (local) return [list.find((m) => m.id === me.id) ?? me]
  const team = list.filter((m) => m.role !== 'guest')
  return team.some((m) => m.id === me.id) ? team : [me, ...team]
}
