import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ApprovalPosting, Timecard, Workspace } from './api'

const integerPercent = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 1 })
const reducedMotion = '(prefers-reduced-motion: reduce)'

type Trail = {
  before: number
  after: number
  hours: number
  rate: number | null
  kind: 'posted' | 'reconciled' | 'projected'
}

function getTrail(card: Timecard | undefined, current: number): Trail | null {
  if (!card || card.costCents === null || card.status === 'returned') return null
  const { hours, rateCents: rate, costCents: cost } = card
  if (card.status === 'pending') return { before: current, after: current + cost, hours, rate, kind: 'projected' }
  if (typeof card.approvedBeforeCents === 'number') {
    return { before: card.approvedBeforeCents, after: card.approvedBeforeCents + cost, hours, rate, kind: 'posted' }
  }
  return { before: current - cost, after: current, hours, rate, kind: 'reconciled' }
}

function plotRange(budget: number, before: number, after: number) {
  const low = Math.min(before, budget)
  const high = Math.max(after, budget)
  const rough = Math.max((high - low) / 4, budget * .02, 1)
  const place = 10 ** Math.floor(Math.log10(rough))
  const step = ([1, 2, 5, 10].find((factor) => factor * place >= rough) ?? 10) * place
  return {
    start: Math.max(0, Math.floor(low / step) * step - 3 * step),
    end: (Math.floor(high / step) + 1) * step,
  }
}

function getLayers({ before, after, hours, rate }: Trail) {
  if (!rate || after <= before) return []
  return Array.from({ length: Math.ceil(hours) }, (_, index) => ({
    from: Math.min(after, before + index * rate),
    to: Math.min(after, before + (index + 1) * rate),
  })).filter(({ from, to }) => to > from)
}

function interpolate(start: number, end: number, fraction: number, quantum: number) {
  const x = Math.max(0, Math.min(1, fraction))
  const ease = x * x * (3 - 2 * x)
  return Math.round((start + (end - start) * ease) / quantum) * quantum
}

type Motion = { posting: ApprovalPosting; cents: number; stage: 'incoming' | 'building' | 'threshold' | 'crossing' }
const handoffDuration = 300

function usePosting(posting: ApprovalPosting | undefined, budget: number) {
  const [motion, setMotion] = useState<Motion | null>(null)

  useLayoutEffect(() => {
    if (!posting) return
    const activePosting = posting
    const preference = window.matchMedia(reducedMotion)
    if (preference.matches) return
    let frame = 0
    const stop = () => {
      cancelAnimationFrame(frame)
      setMotion(null)
    }
    const { beforeCents: before, afterCents: after } = posting
    const quantum = before % 100 === 0 && after % 100 === 0 && budget % 100 === 0 ? 100 : 1
    const reachesBudget = before < budget && after > budget
    const start = performance.now()
    setMotion({ posting, cents: before, stage: 'incoming' })
    function tick(now: number) {
      const elapsed = now - start
      if (elapsed >= 1300) {
        stop()
        return
      }
      let cents = before
      let stage: Motion['stage'] = 'incoming'
      if (elapsed >= handoffDuration) {
        if (!reachesBudget || elapsed < 850) {
          stage = 'building'
          const target = reachesBudget ? budget : after
          const duration = (reachesBudget ? 850 : 1300) - handoffDuration
          cents = Math.min(target - quantum, interpolate(before, target, (elapsed - handoffDuration) / duration, quantum))
        } else if (elapsed < 1000) {
          stage = 'threshold'
          cents = budget
        } else {
          stage = 'crossing'
          cents = Math.max(budget + quantum, interpolate(budget, after, (elapsed - 1000) / 300, quantum))
        }
      }
      setMotion({ posting: activePosting, cents, stage })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    preference.addEventListener('change', stop)
    return () => {
      cancelAnimationFrame(frame)
      preference.removeEventListener('change', stop)
    }
  }, [posting, budget])

  return motion?.posting === posting ? motion : null
}

function PostingToken({ from, to, amount }: { from?: RefObject<SVGSVGElement | null>; to: RefObject<HTMLElement | null>; amount: string }) {
  const token = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = token.current
    const source = from?.current?.getBoundingClientRect()
    const target = to.current?.getBoundingClientRect()
    if (!element || !target) return
    const visible = (rect: DOMRect) => rect.top >= 0 && rect.bottom <= window.innerHeight
    if (!visible(target)) return
    const { width, height } = element.getBoundingClientRect()
    const dx = target.left + (target.width - width) / 2
    const dy = target.top + (target.height - height) / 2
    const sx = source && visible(source) ? source.left + (source.width - width) / 2 : dx - 35
    const sy = source && visible(source) ? source.top + (source.height - height) / 2 : dy
    const transform = (x: number, y: number) => `translate3d(${x}px,${y}px,0)`
    const animation = element.animate([
      { transform: transform(sx, sy), opacity: 0 },
      { opacity: 1, offset: .2 },
      { opacity: 1, offset: .7 },
      { transform: transform(dx, dy), opacity: 0 },
    ], { duration: handoffDuration, easing: 'cubic-bezier(.24,.5,.3,1)' })
    return () => animation.cancel()
  }, [from, to])
  return <span className="manager-posting-token" ref={token} aria-hidden="true">+{amount}</span>
}

function budgetBalance(budget: number, current: number, money: (cents: number) => string) {
  const balance = budget - current
  return balance === 0 ? 'At budget' : `${money(Math.abs(balance))} ${balance < 0 ? 'over budget' : 'remaining'}`
}

type CostTrailProps = {
  project: Workspace['project']
  card?: Timecard
  recordCode?: string
  costsStale?: boolean
  posting?: ApprovalPosting
  sourceAnchor?: RefObject<SVGSVGElement | null>
  openTimecard?: () => void
  money: (cents: number) => string
}

export function CostTrail({ project, card, recordCode, costsStale, posting, sourceAnchor, openTimecard, money }: CostTrailProps) {
  const inlet = useRef<HTMLSpanElement>(null)
  const { budgetCents: budget, approvedCents: current, pendingCents: pending } = project
  const trail = getTrail(card, current)
  const verifiedPosting = trail?.kind === 'posted' && posting && card?.id === posting.cardId &&
    posting.beforeCents === trail.before && posting.afterCents === trail.after && posting.afterCents === current &&
    posting.beforeCents < posting.afterCents ? posting : undefined
  const motion = usePosting(verifiedPosting, budget)
  const total = motion?.cents ?? current
  const stage = motion?.stage ?? 'settled'
  const before = trail?.before ?? total
  const after = trail?.after ?? total
  const level = motion?.cents ?? after
  const forecast = trail?.kind === 'projected'
  const plotted = forecast ? before : level
  const { start, end } = plotRange(budget, before, after)
  const percent = (value: number) => (value - start) / (end - start) * 100
  const layers = trail ? getLayers(trail) : []
  const amount = trail ? trail.after - trail.before : 0
  const plotStyle = {
    '--plot-before': `${percent(before)}%`,
    '--plot-after': `${percent(level)}%`,
    '--plot-budget': `${percent(budget)}%`,
  } as CSSProperties
  const priorLabel = trail?.kind === 'posted' ? 'Before posting' : trail?.kind === 'reconciled' ? 'Other approved labour' : 'Current approved labour'
  const nextLabel = trail?.kind === 'posted' ? 'After posting' : forecast ? 'If approved' : 'Current approved labour'
  const percentage = (value: number) => integerPercent.format(budget ? value / budget * 100 : 0)
  const budgetStatus = budgetBalance(budget, total, money)
  const wholeHours = trail ? Math.floor(trail.hours) : 0
  const partialHours = trail ? Number((trail.hours - wholeHours).toFixed(2)) : 0
  const segments = partialHours && wholeHours ? 'Each full layer = 1 hour. The last layer is partial.' :
    partialHours ? 'The layer represents a partial hour.' : 'Each layer = 1 hour worked'

  return (
    <section className="manager-cost" aria-label="Project labour budget" data-stage={stage} data-crossed={plotted > budget}>
      <div className="manager-cost-topline">
        <p><span className="signal-dot" />{costsStale ? 'Last saved project costs' : 'Live project costs'}</p>
        {openTimecard && <button className="manager-cost-link" type="button" aria-controls="cost-details" onClick={openTimecard}>View approved timecard <ArrowDown size={15} /></button>}
      </div>
      <div className="budget-metrics manager-metrics">
        <div className="manager-amount">
          <h2>Approved labour</h2>
          <strong id="approved-total" aria-hidden={motion ? true : undefined}>{money(total)}</strong>
          {motion && <span className="sr-only">{money(current)} approved labour</span>}
        </div>
        <div className="manager-budget" aria-hidden={motion ? true : undefined}>
          <strong className="manager-balance" data-over={total > budget} data-at={total === budget}>{budgetStatus}</strong>
          <span>of {money(budget)} labour budget</span>
        </div>
        {motion && <span className="sr-only">{budgetBalance(budget, current, money)} against the {money(budget)} labour budget</span>}
        <div className="manager-budget-meta">
          <span aria-hidden={motion ? true : undefined}>{percentage(total)}% of labour budget used</span>
          {motion && <span className="sr-only">{percentage(current)}% of labour budget used</span>}
          <span>Pending labour estimate <strong>{money(pending)}</strong></span>
        </div>
      </div>
      <figure className="manager-trail" aria-labelledby="manager-trail-heading">
        <div className="manager-trail-head">
          <div><h3 id="manager-trail-heading">Cost trail</h3>
            {layers.length > 0 && <span className="manager-trail-legend"><i aria-hidden="true" />{segments}</span>}
          </div>
          {recordCode ? <span className="field-trace-key">{recordCode}</span> : <span className="manager-trail-scope">CAD · Project costs</span>}
        </div>
        <div className="manager-plot" aria-hidden="true">
          <div className="manager-plot-axis"><span>{money(end)}</span><span>{money(start)}</span></div>
          <div className="manager-plot-field" style={plotStyle} data-forecast={forecast} data-has-trail={Boolean(trail)}>
            <span className="manager-plot-grid" />
            <span className="manager-plot-budget"><span>{money(budget)} budget</span></span>
            {trail && <span className="manager-plot-before" />}
            <span className="manager-plot-after" />
            {layers.map(({ from, to }) => {
              const reveal = Math.max(0, Math.min(1, (plotted - from) / (to - from)))
              const split = Math.max(0, Math.min(1, (budget - from) / (to - from)))
              return <span key={from} className="manager-plot-layer" style={{
                bottom: `${percent(from)}%`,
                height: `${percent(to) - percent(from)}%`,
                '--reveal': `${(1 - reveal) * 100}%`,
                '--layer-budget': `${split * 100}%`,
              } as CSSProperties} />
            })}
            {trail && <span className="manager-plot-inlet" ref={inlet} />}
          </div>
        </div>
        {trail && (
          <div className="manager-trail-receipt">
            <div><span>{priorLabel}</span><strong>{money(before)}</strong></div>
            <div className="manager-trail-posting"><span>{forecast ? 'Pending estimate' : 'Timecard posted'}</span><strong>+{money(amount)}</strong></div>
            <div><span>{nextLabel}</span><strong>{money(after)}</strong></div>
          </div>
        )}
        {(!trail || forecast) && <figcaption>
          {forecast ? 'Pending estimates stay outside approved labour until approved.' :
            card?.status === 'returned' ? 'Returned timecards stay outside approved labour.' :
              card ? 'There is no recorded cost to trace for this timecard.' : 'Select a ledger entry to trace the work behind its cost.'}
        </figcaption>}
      </figure>
      {stage === 'incoming' && <PostingToken from={sourceAnchor} to={inlet} amount={money(amount)} />}
    </section>
  )
}
