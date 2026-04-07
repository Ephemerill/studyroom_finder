"""
Scrape study room availability from Biola Libcal using Playwright.
Returns the open times and locations for each room.
"""
import sys
from playwright.sync_api import sync_playwright

def stream_study_rooms(base_url="https://biola.libcal.com/reserve/studyroom"):
    results = []
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # We use a standard user agent to avoid being blocked if Libcal has bot protection
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        yield {"status": "progress", "progress": 10, "message": "Loading LibCal spaces search page..."}
        
        # Navigate to the 'Search by space' URL to list all rooms 
        search_url = f"{base_url}?m=s&search=&gid=15188&capacity=0&zone=0"
        
        # Wait until the network is idle to ensure JS elements are loaded
        page.goto(search_url, wait_until="networkidle")
        # We wait for the rooms to load by waiting for the results title
        page.wait_for_selector("text=Matches", timeout=15000)

        # Extract all room elements
        room_elements = page.locator(".s-lc-booking-suggestion").all()
        rooms_to_check = []
        
        yield {"status": "progress", "progress": 20, "message": f"Found {len(room_elements)} items. Filtering for rooms..."}

        for element in room_elements:
            try:
                name_locator = element.locator("h3.media-heading a")
                # Ensure it's a real room list item by checking if it has a title link
                if name_locator.count() > 0:
                    name = name_locator.inner_text().strip()
                    
                    # Libcal usually puts location info in the booking group
                    location_locator = element.locator(".s-lc-booking-group")
                    location = location_locator.inner_text().strip().replace("\n", " ") if location_locator.count() > 0 else "Unknown Location"
                    
                    href = name_locator.get_attribute("href")
                    if href and "/space/" in href:
                        rooms_to_check.append({
                            "name": name,
                            "location": location,
                            "url": f"https://biola.libcal.com{href}"
                        })
            except Exception as e:
                print(f"Warning: skipped a room due to parse error: {e}")
                
        yield {"status": "progress", "progress": 30, "message": f"Discovered {len(rooms_to_check)} study rooms. Checking schedules..."}
                
        # Now visit each individual room's page to parse the exact available times
        total_rooms = len(rooms_to_check)
        for i, room in enumerate(rooms_to_check):
            # Calculate a nice progress percentage mapped between 30% and 95%
            progress_pct = 30 + int(65 * (i / max(total_rooms, 1)))
            yield {"status": "progress", "progress": progress_pct, "message": f"Checking {room['name']}..."}
            try:
                # Load the individual room's schedule page
                page.goto(room['url'], wait_until="load")
                
                # Wait for the calendar grid to load. We wait for either an event or the grid headers.
                page.wait_for_selector(".fc-timeline-event, .fc-timeline-slot-label", timeout=8000)
                
                available_times = []
                available_slots_locator = page.locator("a.s-lc-eq-avail")
                
                for slot in available_slots_locator.all():
                    title = slot.get_attribute("title")
                    if title:
                        # Libcal slot titles look like: "2:00pm Tuesday, April 7, 2026 - L103 - Available"
                        # Simply extract the first word (the time itself)
                        clean_time = title.split(" ")[0]
                        available_times.append(clean_time)
                        
                room["available_times"] = available_times
                results.append(room)
                
            except Exception as e:
                # Expected if the room schedule fails to load or no grid elements appear
                room["available_times"] = []
                results.append(room)

        browser.close()
        
    yield {"status": "done", "progress": 100, "data": results}

if __name__ == "__main__":
    print("Starting Playwright Headless Scraper...")
    try:
        # NOTE: scrape_study_rooms is undefined in your original standalone block, 
        # but leaving it as you had it just in case you run this strictly manually.
        rooms = list(stream_study_rooms())
        print("\n" + "="*50)
        print("Biola Study Room Availabilities")
        print("="*50)
        
        available_count = 0
        for data_chunk in rooms:
            if data_chunk.get("status") == "done":
                for room in data_chunk["data"]:
                    if room['available_times']:
                        available_count += 1
                        
                    print(f"\nLocation: {room['name']}")
                    print(f"Info: {room['location']}")
                    print(f"Book Here: {room['url']}")
                    
                    if not room['available_times']:
                        print("Status: No available times today/fully booked.")
                    else:
                        print("Open Times:")
                        for time in room['available_times']:
                            print(f"  - {time}")
                            
                print("\n" + "="*50)
                print(f"Total spaces checked: {len(data_chunk['data'])}")
                print(f"Spaces with availability: {available_count}")
                print("="*50)
    except BaseException as e:
        print(f"Error executing script: {e}")
        print("\nMake sure you have Playwright installed and the browsers downloaded:")
        print("    pip install playwright")
        print("    playwright install chromium")
        sys.exit(1)