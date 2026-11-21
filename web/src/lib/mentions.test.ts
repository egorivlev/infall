import { describe, expect, it } from 'vitest'
import { findMentions, insertMention, mentionAt, mentionCandidates, mentionRanges } from './mentions'

const ANA = { id: 'ana', name: 'Ana Ruiz' }
const AN = { id: 'an', name: 'Ana' }
const BEN = { id: 'ben', name: 'Ben Okafor' }
const team = [ANA, AN, BEN]

describe('finding mentions', () => {
  it('reads whole names after an @ that starts a word, the longest name first', () => {
    expect(findMentions('@Ana Ruiz and @Ana, see @Ben Okafor.', team)).toEqual(['ana', 'an', 'ben'])
    expect(mentionRanges('Hi @Ana Ruiz!', team)).toEqual([{ start: 3, end: 12, member: 'ana' }])
  })
  it('ignores addresses, unknown names, and a name that runs on into a word', () => {
    expect(findMentions('mail ana@lab.org or @Anastasia or @Nobody', team)).toEqual([])
  })
  it('counts each Member once, in the order they first appear, whatever the case', () => {
    expect(findMentions('@ben okafor then @Ana then @Ben Okafor', team)).toEqual(['ben', 'an'])
  })
})

describe('completing a mention', () => {
  it('finds the @ being typed at the caret', () => {
    expect(mentionAt('Hello @An', 9)).toEqual({ start: 6, query: 'An' })
    expect(mentionAt('Hello @', 7)).toEqual({ start: 6, query: '' })
    expect(mentionAt('Hello @Ana R', 12)).toEqual({ start: 6, query: 'Ana R' })
  })
  it('is not completing after an address, a line break, or a long run of words', () => {
    expect(mentionAt('ana@la', 6)).toBeNull()
    expect(mentionAt('@Ana\nnext', 9)).toBeNull()
    expect(mentionAt('@a b c d', 8)).toBeNull()
    expect(mentionAt('no at here', 5)).toBeNull()
  })
  it('lists names starting with the query first, then a later word, then by name', () => {
    expect(mentionCandidates('an', team).map((m) => m.id)).toEqual(['an', 'ana'])
    expect(mentionCandidates('ok', team).map((m) => m.id)).toEqual(['ben'])
    expect(mentionCandidates('', team).map((m) => m.id)).toEqual(['an', 'ana', 'ben'])
    expect(mentionCandidates('zz', team)).toEqual([])
  })
  it('puts the whole name in, with one space after it', () => {
    expect(insertMention('Hi @An', 3, 6, 'Ana Ruiz')).toEqual({ text: 'Hi @Ana Ruiz ', caret: 13 })
    expect(insertMention('Hi @An there', 3, 6, 'Ana Ruiz')).toEqual({ text: 'Hi @Ana Ruiz there', caret: 13 })
  })
  it('adds no space before punctuation that follows; an opening bracket still gets one', () => {
    expect(insertMention('@An, can you check?', 0, 3, 'Ana Ruiz')).toEqual({ text: '@Ana Ruiz, can you check?', caret: 9 })
    expect(insertMention('ask @An.', 4, 7, 'Ana Ruiz')).toEqual({ text: 'ask @Ana Ruiz.', caret: 13 })
    expect(insertMention('@An(see)', 0, 3, 'Ana Ruiz')).toEqual({ text: '@Ana Ruiz (see)', caret: 10 })
  })
})
