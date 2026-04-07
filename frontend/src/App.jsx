import { useState } from 'react'
import './index.css'

function App() {
  const [status, setStatus] = useState('idle') // idle, scraping, done
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [rooms, setRooms] = useState([])

  const startScraping = () => {
    setStatus('scraping')
    setProgress(0)
    setStatusMessage('Initializing scraper...')
    setRooms([])

    // Connect to SSE stream via relative path so Nginx can proxy it
    const eventSource = new EventSource('/api/scrape')

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.status === 'progress') {
        setProgress(data.progress)
        setStatusMessage(data.message)
      } else if (data.status === 'done') {
        setRooms(data.data)
        setStatus('done')
        eventSource.close()
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

  return (
    <div className="container">
      <header>
        <h1>Biola Study Rooms</h1>
        <p>Find your next focus space effortlessly.</p>
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
          <div className="results-grid">
            {rooms.map((room, idx) => (
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