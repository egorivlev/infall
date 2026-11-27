import { useCallback, useEffect, useRef, useState } from 'react'
import { invites, members, useMembers } from '../../lib'
import type { Invite, Member } from '../../lib'
import { ConfirmRow } from '../kit'
import { describeError } from './errorMessages'
import { InviteForm } from './InviteForm'
import { MembersTable } from './MembersTable'
import { PendingInvites } from './PendingInvites'

export function Members({ me }: { me: Member }) {
  const people = useMembers()
  const [pending, setPending] = useState<Invite[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [target, setTarget] = useState<Member | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  // After a removal the row is gone: the heading. After Keep: that Member's Remove again.
  const refocus = useRef<'heading' | { remove: string } | null>(null)
  const busyRef = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // M18: whose name the next invite takes over. From the Invite button, or `/members?claim=<id>` (the first screen).
  const [claimId, setClaimId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('claim'))
  const claim = claimId === null ? null : (people.find((p) => p.id === claimId && p.claimed === false) ?? null)

  const loadInvites = useCallback(
    () =>
      invites.list().then(
        (list) => {
          setPending(list)
          setLoadError('')
        },
        (e: unknown) => setLoadError(describeError(e)),
      ),
    [],
  )

  useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  useEffect(() => {
    const to = refocus.current
    if (target || !to) return
    refocus.current = null
    if (to === 'heading') headingRef.current?.focus()
    else document.querySelector<HTMLElement>(`[data-remove="${CSS.escape(to.remove)}"]`)?.focus()
  }, [target])

  async function confirmRemove() {
    if (!target || busyRef.current) return
    busyRef.current = true
    setRemoving(true)
    setRemoveError('')
    try {
      await members.remove(target.id)
      refocus.current = 'heading'
      setTarget(null)
    } catch (e) {
      setRemoveError(describeError(e))
    } finally {
      busyRef.current = false
      setRemoving(false)
    }
  }

  const guests = people.filter((p) => p.role === 'guest').length
  const regular = people.length - guests

  return (
    <div className="q-members">
      <div className="q-members__inner">
        <div className="q-members__main">
          <div className="q-members__title">
            <h1 className="q-screen-title" ref={headingRef} tabIndex={-1}>
              Members
            </h1>
            <span className="q-hint q-members__count">
              {regular} {regular === 1 ? 'Member' : 'Members'}
              {guests > 0 && ` · ${guests} ${guests === 1 ? 'Guest' : 'Guests'}`}
            </span>
          </div>
          <MembersTable
            people={people}
            meId={me.id}
            onRemove={(m) => {
              setRemoveError('')
              setTarget(m)
            }}
            onInvite={(m) => setClaimId(m.id)}
            asking={
              target && {
                id: target.id,
                node: (
                  <ConfirmRow
                    inline
                    question={`Remove ${target.name}?`}
                    detail="They lose access immediately. Their past Changes stay."
                    confirmLabel="Remove"
                    busyLabel="Removing…"
                    busy={removing}
                    error={removeError}
                    onConfirm={() => void confirmRemove()}
                    onKeep={() => {
                      refocus.current = { remove: target.id }
                      setTarget(null)
                    }}
                  />
                ),
              }
            }
          />
          <PendingInvites pending={pending} loadError={loadError} onChanged={() => void loadInvites()} />
        </div>
        <InviteForm
          claim={claim}
          onClearClaim={() => setClaimId(null)}
          onCreated={() => {
            void loadInvites()
            setClaimId(null)
          }}
        />
      </div>
    </div>
  )
}
