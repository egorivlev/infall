import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TourStep } from './steps'
import { tour, useTour } from './store'

const step = (id: string, enter?: TourStep['enter']): TourStep => ({ id, title: id, body: ['.'], anchor: [id], enter })
const showing = () => useTour.getState().steps[useTour.getState().index]?.id

afterEach(() => tour.end())

describe('the tour state', () => {
  it('does not start with fewer than three steps', () => {
    expect(tour.start([step('a'), step('b')])).toBe(false)
    expect(useTour.getState().steps).toEqual([])
    expect(tour.start([step('a'), step('b'), step('c')])).toBe(true)
    expect(showing()).toBe('a')
  })

  it('goes forward and back, and ends after the last step', () => {
    tour.start([step('a'), step('b'), step('c')])
    tour.back() // nothing before the first
    expect(showing()).toBe('a')
    tour.next()
    expect(showing()).toBe('b')
    tour.back()
    expect(showing()).toBe('a')
    tour.next()
    tour.next()
    expect(showing()).toBe('c')
    tour.next()
    expect(useTour.getState().steps).toEqual([])
  })

  it('ends at once, and starts again from the first step', () => {
    tour.start([step('a'), step('b'), step('c')])
    tour.next()
    tour.end()
    expect(showing()).toBeUndefined()
    tour.start([step('a'), step('b'), step('c')])
    expect(showing()).toBe('a')
  })

  it('drops a step whose control went away and moves on', () => {
    tour.start([step('a'), step('b'), step('c'), step('d')])
    tour.next()
    tour.skip()
    expect(showing()).toBe('c')
    expect(useTour.getState().steps.map((s) => s.id)).toEqual(['a', 'c', 'd'])
    tour.back()
    expect(showing()).toBe('a')
    tour.next()
    tour.next()
    tour.skip() // the last one: nothing to move on to
    expect(useTour.getState().steps).toEqual([])
  })

  it('opens what a step needs and puts it back when the step is left', () => {
    const undo = vi.fn()
    const enter = vi.fn(() => undo)
    tour.start([step('a'), step('b', enter), step('c')])
    expect(enter).not.toHaveBeenCalled()
    tour.next()
    expect(enter).toHaveBeenCalledTimes(1)
    expect(undo).not.toHaveBeenCalled()
    tour.next()
    expect(undo).toHaveBeenCalledTimes(1)
    tour.back()
    expect(enter).toHaveBeenCalledTimes(2)
    tour.end()
    expect(undo).toHaveBeenCalledTimes(2)
  })

  it('remembers where focus was', () => {
    const button = document.createElement('button')
    tour.start([step('a'), step('b'), step('c')], button)
    expect(useTour.getState().returnTo).toBe(button)
  })
})
