"""
Scrape study room availability from Biola Libcal using Playwright.
Returns the open times and locations for each room.

Only the La Mirada campus library rooms are reported; the Talbot Phoenix
rooms live in the same LibCal group and are filtered out.
"""
import re
import sys
from datetime import datetime

from playwright.sync_api import sync_playwright

# LibCal group that holds the "Library Study Rooms" spaces.
GROUP_ID = 15188
# Rooms whose name/location match this are at the Talbot Phoenix campus, not La Mirada.
EXCLUDED_CAMPUS_RE = re.compile(r"phoenix", re.IGNORECASE)


def _format_slot_time(raw):
    """'2026-09-09 16:30:00' -> '4:30pm' (the format the frontend parses)."""
    dt = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
    hour = dt.hour % 12 or 12
    return f"{hour}:{dt.minute:02d}{'am' if dt.hour < 12 else 'pm'}"


def _fetch_availability_via_api(page, context, eid):
    """
    Ask LibCal for the same JSON its own availability grid is drawn from.

    One POST returns every slot for every room in the group, so this replaces
    visiting all ~22 room pages. Returns {item_id: [formatted times]}.
    A slot is available when it carries no CSS class; any class
    (s-lc-eq-checkout, s-lc-eq-r-unavailable, ...) means it is taken or closed.
    """
    # springyPage is the config blob LibCal renders into each space page.
    config = page.evaluate(
        "() => ({ lid: springyPage.locationId, gid: springyPage.groupId,"
        " zone: springyPage.zoneId, pageSize: springyPage.pageSize })"
    )

    # LibCal expects a start/end pair; it trims the response to slots that are
    # still bookable, so past times never come back.
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    end = datetime.fromordinal(now.toordinal() + 1).strftime("%Y-%m-%d")

    response = context.request.post(
        "https://biola.libcal.com/spaces/availability/grid",
        form={
            "lid": str(config["lid"]),
            "gid": str(config["gid"]),
            "eid": str(eid),
            "seat": "0",
            "seatId": "0",
            "zone": str(config["zone"] or 0),
            "start": today,
            "end": end,
            "pageIndex": "0",
            "pageSize": str(config["pageSize"] or 100),
        },
        headers={
            "X-Requested-With": "XMLHttpRequest",
            "Referer": f"https://biola.libcal.com/space/{eid}",
        },
    )
    if not response.ok:
        raise RuntimeError(f"availability grid returned HTTP {response.status}")

    slots = response.json().get("slots") or []
    availability = {}
    for slot in slots:
        item_id = slot.get("itemId")
        if item_id is None:
            continue
        availability.setdefault(item_id, [])
        if not slot.get("className"):
            availability[item_id].append(_format_slot_time(slot["start"]))
    return availability


def _fetch_availability_via_dom(page):
    """
    Fallback for a single room page if the JSON endpoint ever changes.

    FullCalendar 6 no longer puts a `title` on the slot anchors (that is what
    broke the original scraper), so match each green ".s-lc-eq-avail" block to
    the timeline column it sits over using pixel positions.
    """
    return page.evaluate(
        """() => {
            // One <td> per half-hour column, each tagged with the time it covers.
            const columns = [...document.querySelectorAll('.fc-timeline-slot-lane[data-date]')]
                .map(el => {
                    const box = el.getBoundingClientRect();
                    return { left: box.left, right: box.right, date: el.dataset.date };
                })
                .filter(c => c.right > c.left);
            if (!columns.length) return [];

            const times = [];
            for (const event of document.querySelectorAll('a.s-lc-eq-avail')) {
                const box = event.getBoundingClientRect();
                const center = box.left + box.width / 2;
                const column = columns.find(c => center >= c.left && center < c.right);
                if (!column) continue;
                const dt = new Date(column.date);
                const hour = dt.getHours() % 12 || 12;
                const minute = String(dt.getMinutes()).padStart(2, '0');
                times.push({
                    sort: dt.getTime(),
                    label: `${hour}:${minute}${dt.getHours() < 12 ? 'am' : 'pm'}`,
                });
            }
            times.sort((a, b) => a.sort - b.sort);
            return [...new Set(times.map(t => t.label))];
        }"""
    )


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
        search_url = f"{base_url}?m=s&search=&gid={GROUP_ID}&capacity=0&zone=0"

        # Wait until the network is idle to ensure JS elements are loaded
        page.goto(search_url, wait_until="networkidle")
        # We wait for the rooms to load by waiting for the results title
        page.wait_for_selector("text=Matches", timeout=15000)

        # Extract all room elements
        room_elements = page.locator(".s-lc-booking-suggestion").all()
        rooms_to_check = []
        skipped_other_campus = 0

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
                    if not href or "/space/" not in href:
                        continue

                    # Talbot Phoenix shares this LibCal group; we only want La Mirada.
                    if EXCLUDED_CAMPUS_RE.search(name) or EXCLUDED_CAMPUS_RE.search(location):
                        skipped_other_campus += 1
                        continue

                    eid_match = re.search(r"/space/(\d+)", href)
                    if not eid_match:
                        continue

                    rooms_to_check.append({
                        "id": int(eid_match.group(1)),
                        "name": name,
                        "location": location,
                        "url": f"https://biola.libcal.com{href}"
                    })
            except Exception as e:
                print(f"Warning: skipped a room due to parse error: {e}")

        yield {
            "status": "progress",
            "progress": 40,
            "message": f"Discovered {len(rooms_to_check)} La Mirada study rooms "
                       f"(skipped {skipped_other_campus} Phoenix). Checking schedules...",
        }

        if not rooms_to_check:
            browser.close()
            yield {"status": "error", "progress": 100, "message": "No study rooms found on the LibCal page."}
            return

        # Open one room page so LibCal hands us a session, then pull the whole
        # group's schedule in a single request instead of loading every room.
        first_room = rooms_to_check[0]
        page.goto(first_room["url"], wait_until="domcontentloaded")
        page.wait_for_selector(".fc-timeline-slot-label, .fc-timeline-event", timeout=15000)

        yield {"status": "progress", "progress": 60, "message": "Reading the availability grid..."}

        availability = {}
        try:
            availability = _fetch_availability_via_api(page, context, first_room["id"])
        except Exception as e:
            print(f"Warning: availability API failed ({e}); falling back to per-room DOM parsing.")

        if availability:
            for room in rooms_to_check:
                room["available_times"] = availability.get(room["id"], [])
                results.append(room)
        else:
            # Fallback: walk each room page and read the rendered grid.
            total_rooms = len(rooms_to_check)
            for i, room in enumerate(rooms_to_check):
                progress_pct = 60 + int(35 * (i / max(total_rooms, 1)))
                yield {"status": "progress", "progress": progress_pct, "message": f"Checking {room['name']}..."}
                try:
                    if i > 0:
                        page.goto(room["url"], wait_until="domcontentloaded")
                    # The grid skeleton renders before its events arrive, so wait
                    # for an actual slot block rather than just the time labels.
                    page.wait_for_selector(".fc-timeline-event", timeout=10000)
                    room["available_times"] = _fetch_availability_via_dom(page)
                except Exception as e:
                    print(f"Warning: could not read schedule for {room['name']}: {e}")
                    room["available_times"] = []
                results.append(room)

        browser.close()

    yield {"status": "done", "progress": 100, "data": results}

if __name__ == "__main__":
    print("Starting Playwright Headless Scraper...")
    try:
        rooms = list(stream_study_rooms())
        print("\n" + "="*50)
        print("Biola Study Room Availabilities")
        print("="*50)

        available_count = 0
        for data_chunk in rooms:
            if data_chunk.get("status") == "error":
                print(f"Error: {data_chunk['message']}")
                sys.exit(1)
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
