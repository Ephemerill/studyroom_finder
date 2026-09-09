import { useMemo, useState } from 'react'
import './index.css'

const SLOT_MINUTES = 30

const toMinutes = (clock) => {
  const [hour, minute] = clock.split(':').map(Number)
  return hour * 60 + minute
}

const clockLabel = (minutes) => {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(wrapped / 60)
  const minute = wrapped % 60
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
}

const hourLabel = (minutes) => {
  const hour = Math.floor((((minutes % 1440) + 1440) % 1440) / 60)
  return `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`
}

const durationLabel = (minutes) => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest}m`
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

// The server's clock is the one LibCal's grid was built against, so read "now"
// from the scrape timestamp rather than the viewer's device.
const scrapeMinutes = (timestamp, fallback) => {
  const match = /T(\d{2}):(\d{2})/.exec(timestamp || '')
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback
}

/** Collapse a room's open half-hour slots into contiguous blocks. */
const openBlocks = (slots) => {
  const blocks = []
  for (const minute of slots.map(toMinutes).sort((a, b) => a - b)) {
    const previous = blocks[blocks.length - 1]
    if (previous && previous.end === minute) previous.end = minute + SLOT_MINUTES
    else blocks.push({ start: minute, end: minute + SLOT_MINUTES })
  }
  return blocks
}

const buildBoard = (payload) => {
  const start = toMinutes(payload.window.start)
  const end = toMinutes(payload.window.end)
  const now = scrapeMinutes(payload.generated_at, start)

  const rooms = payload.data.map((room) => {
    const blocks = openBlocks(room.open_slots || [])
    return {
      ...room,
      blocks,
      openNow: blocks.find((block) => now >= block.start && now < block.end),
      nextOpen: blocks.find((block) => block.start > now),
    }
  })

  return { start, end, now, slots: Math.max(1, Math.round((end - start) / SLOT_MINUTES)), rooms }
}

/**
 * Hour ticks across the board, thinned out when the day still has a long way to
 * run, and clear of the "now" marker that always sits at the left edge.
 */
const rulerTicks = (start, end, now) => {
  const step = end - start > 10 * 60 ? 120 : 60
  const ticks = []
  for (let minute = Math.ceil(start / step) * step; minute <= end; minute += step) {
    if (Math.abs(minute - now) > 35) ticks.push(minute)
  }
  return ticks
}

/** The headline answer: what is free this minute, and when the next rooms free up. */
const summarise = (rooms) => {
  const openNow = rooms.filter((room) => room.openNow).length
  const upcoming = rooms
    .filter((room) => !room.openNow && room.nextOpen)
    .map((room) => room.nextOpen.start)
  if (!upcoming.length) return { openNow, next: null }
  const soonest = Math.min(...upcoming)
  return { openNow, next: { at: soonest, count: upcoming.filter((start) => start === soonest).length } }
}

const compare = {
  open: (a, b) => {
    if (a.openNow && b.openNow) return b.openNow.end - a.openNow.end
    if (a.openNow) return -1
    if (b.openNow) return 1
    if (a.nextOpen && b.nextOpen) return a.nextOpen.start - b.nextOpen.start
    if (a.nextOpen) return -1
    if (b.nextOpen) return 1
    return a.code.localeCompare(b.code)
  },
  room: (a, b) => a.code.localeCompare(b.code),
}

function Strip({ room, board }) {
  const span = board.end - board.start
  const offset = (minute) => ((minute - board.start) / span) * 100

  return (
    <div className="strip" aria-hidden="true">
      {room.blocks.map((block) => (
        <span
          key={block.start}
          className="strip__open"
          style={{ left: `${offset(block.start)}%`, width: `${offset(block.end) - offset(block.start)}%` }}
        />
      ))}
      <span className="strip__now" style={{ left: `${offset(board.now)}%` }} />
    </div>
  )
}

function Row({ room, board, index }) {
  const status = room.openNow
    ? { headline: 'Open now', detail: `${durationLabel(room.openNow.end - board.now)} left` }
    : room.nextOpen
      ? { headline: `Opens ${clockLabel(room.nextOpen.start)}`, detail: durationLabel(room.nextOpen.end - room.nextOpen.start) }
      : { headline: 'Booked', detail: 'nothing left today' }

  return (
    <a
      className="row"
      href={room.url}
      target="_blank"
      rel="noreferrer"
      style={{ '--row-index': index }}
      data-open={room.openNow ? 'true' : 'false'}
      aria-label={`${room.code}, ${room.level}, ${room.capacity} people. ${status.headline}, ${status.detail}. Book on LibCal.`}
    >
      <span className="row__id">
        <span className="row__code">{room.code}</span>
        <span className="row__meta">
          {room.capacity.replace('-', '–')} people
          {room.presentation && <span className="row__tag">presentation</span>}
        </span>
      </span>
      <Strip room={room} board={board} />
      <span className="row__status">
        <span className="row__headline">{status.headline}</span>
        <span className="row__detail">{status.detail}</span>
      </span>
    </a>
  )
}

function Board({ board }) {
  const [level, setLevel] = useState('all')
  const [order, setOrder] = useState('open')

  const levels = useMemo(
    () => [...new Set(board.rooms.map((room) => room.level))].sort(),
    [board.rooms],
  )

  const rooms = useMemo(
    () =>
      board.rooms
        .filter((room) => level === 'all' || room.level === level)
        .sort(compare[order]),
    [board.rooms, level, order],
  )

  const { openNow, next } = summarise(board.rooms)
  const ticks = rulerTicks(board.start, board.end, board.now)
  const span = board.end - board.start

  return (
    <>
      <div className="summary">
        <p className="summary__count">
          {openNow > 0 ? (
            <>
              <strong>{openNow}</strong> {openNow === 1 ? 'room' : 'rooms'} free right now
            </>
          ) : (
            <strong>Nothing free right now</strong>
          )}
          {next && (
            <span className="summary__next">
              {openNow > 0 ? `${next.count} more` : `${next.count} ${next.count === 1 ? 'room' : 'rooms'}`} from{' '}
              {clockLabel(next.at)}
            </span>
          )}
        </p>
        <div className="filters">
          <div className="chips" role="group" aria-label="Filter by level">
            <button className="chip" aria-pressed={level === 'all'} onClick={() => setLevel('all')}>
              All
            </button>
            {levels.map((name) => (
              <button key={name} className="chip" aria-pressed={level === name} onClick={() => setLevel(name)}>
                {name.replace(/\s*level$/i, '')}
              </button>
            ))}
          </div>
          <label className="sort">
            Sort
            <select value={order} onChange={(event) => setOrder(event.target.value)}>
              <option value="open">Open longest</option>
              <option value="room">Room number</option>
            </select>
          </label>
        </div>
      </div>

      <div className="board">
        <div className="ruler" aria-hidden="true">
          {ticks.map((minute) => {
            const at = ((minute - board.start) / span) * 100
            return (
              <span
                key={minute}
                // Odd hours drop out on narrow screens, where labels would collide.
                className={`ruler__tick${Math.floor(minute / 60) % 2 ? ' ruler__tick--minor' : ''}`}
                // Ticks near the right end hug the edge so their label is not clipped.
                style={{ left: `${at}%`, transform: `translateX(${at > 92 ? '-100%' : '-50%'})` }}
              >
                {hourLabel(minute)}
              </span>
            )
          })}
          <span className="ruler__now" style={{ left: `${((board.now - board.start) / span) * 100}%` }}>
            now
          </span>
        </div>

        {rooms.map((room, index) => (
          <Row key={room.id} room={room} board={board} index={index} />
        ))}

        {rooms.length === 0 && <p className="board__empty">No rooms on that level.</p>}
      </div>
    </>
  )
}

export default function App() {
  const [state, setState] = useState({ phase: 'idle' })

  const check = () => {
    setState({ phase: 'checking', progress: 0, message: 'Opening LibCal' })

    // Relative path in production so Nginx can proxy the stream.
    const source = new EventSource(
      import.meta.env.DEV ? 'http://127.0.0.1:5000/api/scrape' : '/api/scrape',
    )

    source.onmessage = (event) => {
      const step = JSON.parse(event.data)

      if (step.status === 'progress') {
        setState({ phase: 'checking', progress: step.progress, message: step.message })
      } else if (step.status === 'done') {
        setState({ phase: 'done', board: buildBoard(step) })
        source.close()
      } else if (step.status === 'error') {
        setState({ phase: 'error', message: step.message })
        source.close()
      }
    }

    source.onerror = () => {
      setState({ phase: 'error', message: "Couldn't reach the room checker." })
      source.close()
    }
  }

  return (
    <div className="page">
      <header className="masthead">
        <h1>Study rooms</h1>
        <p className="masthead__where">Biola Library, La Mirada</p>
        <p className="masthead__aside">Time to kick someone out :)</p>
      </header>

      {state.phase === 'idle' && (
        <div className="lede">
          <p>Every room in the library, every half hour left in today.</p>
          <p className="legend">
            <span className="legend__item">
              <span className="legend__swatch legend__swatch--free" />free
            </span>
            <span className="legend__item">
              <span className="legend__swatch legend__swatch--booked" />booked
            </span>
            <span className="legend__item">
              <span className="legend__swatch legend__swatch--now" />right now
            </span>
          </p>
          <button className="action" onClick={check}>
            Check availability
          </button>
        </div>
      )}

      {state.phase === 'checking' && (
        <div className="lede" role="status">
          <p className="lede__progress">{state.message}</p>
          <div className="meter">
            <span className="meter__fill" style={{ width: `${state.progress}%` }} />
          </div>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="lede" role="alert">
          <p>{state.message}</p>
          <button className="action" onClick={check}>
            Try again
          </button>
        </div>
      )}

      {state.phase === 'done' && (
        <>
          <Board board={state.board} />
          <footer className="footer">
            <button className="action action--quiet" onClick={check}>
              Check again
            </button>
            <p className="footer__stamp">Checked at {clockLabel(state.board.now)}</p>
          </footer>
        </>
      )}
    </div>
  )
}
