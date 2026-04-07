import json
from flask import Flask, Response
from flask_cors import CORS
from scraper import stream_study_rooms

app = Flask(__name__)
CORS(app)

@app.route('/api/scrape', methods=['GET'])
def scrape_endpoint():
    def generate():
        # Scraper is a generator that yields dicts
        for step in stream_study_rooms():
            # SSE format is "data: <json string>\n\n"
            yield f"data: {json.dumps(step)}\n\n"
            
    return Response(generate(), mimetype='text/event-stream')

if __name__ == "__main__":
    app.run(debug=True, port=5000)
