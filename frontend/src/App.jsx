import { useEffect, useMemo, useState } from 'react'
import '@fontsource/big-shoulders-display/800'
import '@fontsource/big-shoulders-display/900'
import '@fontsource/hanken-grotesk/400'
import '@fontsource/hanken-grotesk/600'
import '@fontsource/hanken-grotesk/700'
import './index.css'

const SLOT_MINUTES = 30

const toMinutes = (clock) => {
  const [hour, minute] = clock.split(':').map(Number)
  return hour * 60 + minute
}

const wrap = (minutes) => ((minutes % 1440) + 1440) % 1440

/** 990 -> { time: '4:30', period: 'pm' } */
const clockParts = (minutes) => {
  const wrapped = wrap(minutes)
  const hour = Math.floor(wrapped / 60)
  return {
    time: `${hour % 12 || 12}:${String(wrapped % 60).padStart(2, '0')}`,
    period: hour < 12 ? 'am' : 'pm',
  }
}

const clockLabel = (minutes) => {
  const { time, period } = clockParts(minutes)
  return `${time}${period}`
}

const hourLabel = (minutes) => {
  const hour = Math.floor(wrap(minutes) / 60)
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

/** "Upper Level" -> "Upper" */
const levelName = (level) => level.replace(/\s*level$/i, '')
const levelKind = (level) => (/upper/i.test(level) ? 'upper' : /lower/i.test(level) ? 'lower' : 'other')

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
 * Hour ticks across the ruler, thinned out when the day still has a long way to
 * run, and clear of the "now" label that always sits at the left edge.
 */
const rulerTicks = (start, end, now) => {
  const step = end - start > 8 * 60 ? 120 : 60
  const ticks = []
  for (let minute = Math.ceil(start / step) * step; minute <= end; minute += step) {
    // Keep clear of the "now" label pinned at the left edge.
    if ((minute - now) / (end - start) > 0.13) ticks.push(minute)
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

const roomStatus = (room, now) => {
  if (room.openNow) {
    return { kind: 'free', label: 'Free till', at: room.openNow.end, note: `${durationLabel(room.openNow.end - now)} left` }
  }
  if (room.nextOpen) {
    return {
      kind: 'later',
      label: 'Opens',
      at: room.nextOpen.start,
      note: `until ${clockLabel(room.nextOpen.end)}`,
    }
  }
  return { kind: 'booked', label: 'Booked', at: null, note: 'nothing left today' }
}

function Stamp({ status }) {
  if (status.at === null) {
    return (
      <span className="stamp stamp--booked">
        <span className="stamp__word">{status.label}</span>
      </span>
    )
  }
  const { time, period } = clockParts(status.at)
  return (
    <span className={`stamp stamp--${status.kind}`}>
      <span className="stamp__label">{status.label}</span>
      <span className="stamp__time">
        {time}
        <span className="stamp__period">{period}</span>
      </span>
    </span>
  )
}

function Timeline({ blocks, start, end, now }) {
  const span = end - start
  const offset = (minute) => ((Math.min(Math.max(minute, start), end) - start) / span) * 100
  return (
    <span className="timeline" style={{ '--slots': Math.max(1, Math.round(span / SLOT_MINUTES)) }} aria-hidden="true">
      {blocks.map((block) => (
        <span
          key={block.start}
          className="timeline__open"
          style={{ left: `${offset(block.start)}%`, width: `${offset(block.end) - offset(block.start)}%` }}
        />
      ))}
      <span className="timeline__now" style={{ left: `${offset(now)}%` }} />
    </span>
  )
}

function LevelTag({ level }) {
  return <span className={`tag tag--${levelKind(level)}`}>{levelName(level)}</span>
}

function Slip({ room, board, index }) {
  const status = roomStatus(room, board.now)
  const meta = [status.note, room.capacity && `${room.capacity.replace('-', '–')} people`, room.presentation && 'presentation screen'].filter(Boolean)
  const spoken = status.at === null ? 'Booked for the rest of today' : `${status.label} ${clockLabel(status.at)}, ${status.note}`

  return (
    <li>
      <a
        className="slip"
        href={room.url}
        target="_blank"
        rel="noreferrer"
        data-status={status.kind}
        style={{ '--i': Math.min(index, 8) }}
        aria-label={`${room.code}, ${room.level}${room.capacity ? `, ${room.capacity} people` : ''}. ${spoken}. Book on LibCal.`}
      >
        <span className="slip__head">
          <span className="slip__code">{room.code}</span>
          <LevelTag level={room.level} />
          <svg className="slip__go" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 11 11 5M6 5h5v5" />
          </svg>
        </span>
        <span className="slip__meta">
          {meta.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
        <Stamp status={status} />
        <Timeline blocks={room.blocks} start={board.start} end={board.end} now={board.now} />
      </a>
    </li>
  )
}

function Toolbar({ levels, level, setLevel, order, setOrder, board }) {
  const span = board.end - board.start
  const at = (minute) => ((minute - board.start) / span) * 100

  return (
    <div className="toolbar">
      <div className="toolbar__controls">
        <div className="segmented" role="group" aria-label="Filter by level">
          <button type="button" aria-pressed={level === 'all'} onClick={() => setLevel('all')}>
            All
          </button>
          {levels.map((name) => (
            <button key={name} type="button" aria-pressed={level === name} onClick={() => setLevel(name)}>
              {levelName(name)}
            </button>
          ))}
        </div>
        <label className="sort">
          <span className="sort__label">Sort</span>
          <select value={order} onChange={(event) => setOrder(event.target.value)}>
            <option value="open">Open longest</option>
            <option value="room">Room number</option>
          </select>
        </label>
      </div>
      <div className="ruler" aria-hidden="true">
        <span className="ruler__now">now</span>
        {rulerTicks(board.start, board.end, board.now).map((minute, index) => (
          <span
            key={minute}
            // Every other label drops out on the narrowest phones, where they would collide.
            className={`ruler__tick${index % 2 ? ' ruler__tick--minor' : ''}`}
            style={{ left: `${at(minute)}%`, transform: `translateX(${at(minute) > 90 ? '-100%' : '-50%'})` }}
          >
            {hourLabel(minute)}
          </span>
        ))}
      </div>
    </div>
  )
}

function Board({ board }) {
  const [level, setLevel] = useState('all')
  const [order, setOrder] = useState('open')
  // Stamps press on once per check; filtering and sorting afterwards never replay them.
  const [fresh, setFresh] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setFresh(false), 900)
    return () => clearTimeout(timer)
  }, [])

  const levels = useMemo(() => [...new Set(board.rooms.map((room) => room.level))].sort(), [board.rooms])

  const rooms = useMemo(
    () => board.rooms.filter((room) => level === 'all' || room.level === level).sort(compare[order]),
    [board.rooms, level, order],
  )

  return (
    <>
      <Toolbar levels={levels} level={level} setLevel={setLevel} order={order} setOrder={setOrder} board={board} />
      {rooms.length > 0 ? (
        <ol className="slips" data-fresh={fresh || undefined}>
          {rooms.map((room, index) => (
            <Slip key={room.id} room={room} board={board} index={index} />
          ))}
        </ol>
      ) : (
        <p className="slips__empty">No rooms listed on that level today.</p>
      )}
    </>
  )
}

/** Two illustrative slips on the start screen that teach how a stamp reads. */
function Example() {
  const board = { start: 12 * 60 + 30, end: 24 * 60, now: 12 * 60 + 32 }
  const examples = [
    {
      code: 'U112',
      level: 'Upper Level',
      status: { kind: 'free', label: 'Free till', at: 16 * 60, note: '3h 28m left' },
      blocks: [{ start: 750, end: 960 }, { start: 1080, end: 1410 }],
    },
    {
      code: 'L103',
      level: 'Lower Level',
      status: { kind: 'later', label: 'Opens', at: 15 * 60, note: 'until 12:00am' },
      blocks: [{ start: 900, end: 1440 }],
    },
  ]

  return (
    <figure className="example">
      <figcaption className="example__caption">
        <span className="example__title">How to read a slip</span>
        <span className="example__note">Example rooms, not live data</span>
      </figcaption>
      <ul className="slips slips--example" aria-hidden="true">
        {examples.map((room) => (
          <li key={room.code}>
            <span className="slip" data-status={room.status.kind}>
              <span className="slip__head">
                <span className="slip__code">{room.code}</span>
                <LevelTag level={room.level} />
              </span>
              <span className="slip__meta">
                <span>{room.status.note}</span>
              </span>
              <Stamp status={room.status} />
              <Timeline blocks={room.blocks} start={board.start} end={board.end} now={board.now} />
            </span>
          </li>
        ))}
      </ul>
      <ul className="example__key">
        <li>
          <span className="key-swatch key-swatch--free" />A red stamp means you can walk in now.
        </li>
        <li>
          <span className="key-swatch key-swatch--later" />A grey stamp is the next time it opens.
        </li>
        <li>
          <span className="key-swatch key-swatch--line" />The line is the rest of today. Solid is open.
        </li>
      </ul>
    </figure>
  )
}

function Waiting() {
  return (
    <ol className="slips slips--waiting" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((n) => (
        <li key={n}>
          <span className="slip slip--blank" style={{ '--i': n }}>
            <span className="slip__head">
              <span className="blank blank--code" />
            </span>
            <span className="blank blank--meta" />
            <span className="blank blank--stamp" />
            <span className="timeline" style={{ '--slots': 23 }} />
          </span>
        </li>
      ))}
    </ol>
  )
}

function Answer({ board }) {
  const { openNow, next } = summarise(board.rooms)
  const nextLine = next
    ? `${next.count} ${openNow > 0 ? 'more' : next.count === 1 ? 'room' : 'rooms'} ${next.count === 1 ? 'opens' : 'open'} at ${clockLabel(next.at)}`
    : openNow > 0
      ? 'Nothing else opens later today'
      : 'Every room is booked for the rest of today'

  return (
    <>
      <h1 className="answer">
        <span className="answer__count">{openNow}</span>
        <span className="answer__words">
          {openNow === 1 ? 'room' : 'rooms'}
          <br />
          free now
        </span>
      </h1>
      <p className="masthead__sub">{nextLine}</p>
    </>
  )
}

export default function App() {
  const [state, setState] = useState({ phase: 'idle' })

  const check = () => {
    setState({ phase: 'checking', progress: 4, message: 'Opening LibCal' })

    // Relative path in production so Nginx can proxy the stream.
    const source = new EventSource(import.meta.env.DEV ? 'http://127.0.0.1:5000/api/scrape' : '/api/scrape')

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
      setState({ phase: 'error', message: 'The room checker didn’t answer. Check your connection and try again.' })
      source.close()
    }
  }

  const { phase } = state

  return (
    <div className="app" data-phase={phase}>
      <header className="masthead">
        <div className="masthead__inner">
          <div className="masthead__bar">
            <span className="brand">Study Rooms</span>
            {phase === 'done' ? (
              <button
                type="button"
                className="refresh"
                onClick={check}
                aria-label={`Check again, last checked ${clockLabel(state.board.now)}`}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
                </svg>
                Check again
                <span className="refresh__time">{clockLabel(state.board.now)}</span>
              </button>
            ) : (
              <span className="masthead__where">Biola Library · La Mirada</span>
            )}
          </div>

          {phase === 'idle' && (
            <>
              <h1 className="question">Which study rooms are free right now?</h1>
              <p className="masthead__sub">Every room in the library, for the rest of today.</p>
              <button type="button" className="action" onClick={check}>
                Check rooms
              </button>
            </>
          )}

          {phase === 'checking' && (
            <div role="status">
              <h1 className="question">Checking rooms…</h1>
              <p className="masthead__sub">{state.message}</p>
              <div className="meter">
                <span className="meter__fill" style={{ width: `${state.progress}%` }} />
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div role="alert">
              <h1 className="question">Couldn’t check the rooms.</h1>
              <p className="masthead__sub">{state.message}</p>
              <button type="button" className="action" onClick={check}>
                Try again
              </button>
            </div>
          )}

          {phase === 'done' && <Answer board={state.board} />}
        </div>
      </header>

      <main className="sheet">
        {phase === 'idle' && <Example />}
        {phase === 'checking' && <Waiting />}
        {phase === 'done' && <Board board={state.board} />}
      </main>

      <footer className="colophon">
        Unofficial student tool, not affiliated with Biola University. Tap a room to book it on LibCal.
      </footer>
    </div>
  )
}
