import { useState, useMemo } from 'react'
import './index.css'

const parseTime = (timeStr) => {
  if (!timeStr) return Infinity;
  const match = timeStr.match(/(\d+):(\d+)(am|pm)/i);
  if (!match) return Infinity;
  let [_, h, m, ampm] = match;
  h = parseInt(h);
  m = parseInt(m);
  if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
  if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + m;
};

function App() {
  const [status, setStatus] = useState('idle') // idle, scraping, done
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [rooms, setRooms] = useState([])
  const [sortBy, setSortBy] = useState('none') // none, lower, upper, time

  const startScraping = () => {
    setStatus('scraping')
    setProgress(0)
    setStatusMessage('Initializing scraper...')
    setRooms([])

    // Connect to SSE stream via relative path so Nginx can proxy it 
    // In dev mode, use the explicit localhost address
    const apiUrl = import.meta.env.DEV ? 'http://127.0.0.1:5000/api/scrape' : '/api/scrape';
    const eventSource = new EventSource(apiUrl)

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.status === 'progress') {
        setProgress(data.progress)
        setStatusMessage(data.message)
      } else if (data.status === 'done') {
        setRooms(data.data)
        setStatus('done')
        eventSource.close()
      } else if (data.status === 'error') {
        // Surface a scrape failure instead of silently showing every room as booked
        setStatusMessage(data.message || 'The scraper could not read LibCal.')
        eventSource.close()
        setTimeout(() => setStatus('idle'), 4000)
      }
    }

    eventSource.onerror = (error) => {
      console.error('SSE Error:', error)
      setStatusMessage('Error connecting to scraper.')
      eventSource.close()
      // Fallback reset after a bit
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  const sortedRooms = useMemo(() => {
    let sorted = [...rooms];
    if (sortBy === 'lower') {
      sorted.sort((a, b) => {
        const aL = a.location.toLowerCase().includes('lower');
        const bL = b.location.toLowerCase().includes('lower');
        return aL === bL ? 0 : aL ? -1 : 1;
      });
    } else if (sortBy === 'upper') {
      sorted.sort((a, b) => {
        const aU = a.location.toLowerCase().includes('upper');
        const bU = b.location.toLowerCase().includes('upper');
        return aU === bU ? 0 : aU ? -1 : 1;
      });
    } else if (sortBy === 'time') {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      
      const getClosestTimeDiff = (times) => {
        if (!times || times.length === 0) return Infinity; // Fully booked
        let minDiff = Infinity;
        times.forEach((t) => {
          const tMin = parseTime(t);
          if (tMin !== Infinity) {
            // Find absolute difference between now and the available slot
            const diff = Math.abs(tMin - currentMinutes);
            if (diff < minDiff) minDiff = diff;
          }
        });
        return minDiff;
      };
      
      sorted.sort((a, b) => getClosestTimeDiff(a.available_times) - getClosestTimeDiff(b.available_times));
    }
    return sorted;
  }, [rooms, sortBy]);

  return (
    <div className="container">
      <header>
        <h1>Study Room finder</h1>
        <p>Time to kick someone out :)</p>
      </header>

      {status === 'idle' && (
        <div className="center-content">
          <button className="primary-btn" onClick={startScraping}>
            Find Open Rooms
          </button>
        </div>
      )}

      {status === 'scraping' && (
        <div className="progress-container">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="progress-text">{statusMessage}</div>
        </div>
      )}

      {status === 'done' && (
        <>
          <div className="controls-bar" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem', gap: '1rem', alignItems: 'center' }}>
            <label htmlFor="sortOpt" style={{ color: 'var(--text-muted)'}}>Sort By:</label>
            <select id="sortOpt" className="sort-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="none">Default</option>
              <option value="lower">Lower Level First</option>
              <option value="upper">Upper Level First</option>
              <option value="time">Closest Open Time</option>
            </select>
          </div>
          <div className="results-grid">
            {sortedRooms.map((room, idx) => (
              <div className="glass-panel room-card" key={idx}>
                <div className="room-header">
                  <h3 className="room-title">{room.name}</h3>
                  <div className="room-location">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                      <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                    {room.location}
                  </div>
                </div>

                <div className="room-content">
                  <div className="times-title">Available Times</div>
                  {room.available_times && room.available_times.length > 0 ? (
                    <div className="times-grid">
                      {room.available_times.map((time, tIdx) => (
                        <span key={tIdx} className="time-pill">{time}</span>
                      ))}
                    </div>
                  ) : (
                    <div className="no-times">Fully Booked / Closed</div>
                  )}
                </div>

                <div className="card-footer">
                  <a href={room.url} target="_blank" rel="noreferrer" className="book-btn">
                    Book This Room
                  </a>
                </div>
              </div>
            ))}
          </div>

          <div style={{ textAlign: 'center', marginTop: '3rem' }}>
            <button className="primary-btn" onClick={() => setStatus('idle')} style={{ padding: '0.8rem 2rem', fontSize: '1rem' }}>
              Search Again
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default App