"""
Scrape study room availability from Biola LibCal using Playwright.

Only La Mirada campus rooms are reported; the Talbot Phoenix rooms share the
same LibCal group and are filtered out.

Availability comes from the JSON endpoint LibCal's own booking grid is drawn
from, which is one request for every room instead of one page load per room.
"""
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright

# LibCal schedules La Mirada rooms in Pacific time. Every "today" and "now" is
# read in this zone, never the host's: a server on UTC is already on tomorrow by
# 4pm Pacific and would otherwise ask LibCal for the wrong day.
CAMPUS_TZ = ZoneInfo("America/Los_Angeles")

# LibCal group holding the "Library Study Rooms" spaces.
GROUP_ID = 15188
# Rooms matching this are at the Talbot Phoenix campus, not La Mirada.
EXCLUDED_CAMPUS_RE = re.compile(r"phoenix", re.IGNORECASE)
# "L103 (5-8 people) - lower level room" -> code "L103", capacity "5-8"
ROOM_NAME_RE = re.compile(r"^\s*(?P<code>[A-Z]+\d+)\s*(?:\((?P<capacity>[\d\s-]+?)\s*people\))?")


SLOT_MINUTES = 30


def _to_minutes(clock):
    """'16:30' -> 990, minutes since midnight."""
    hour, minute = (int(part) for part in clock.split(":"))
    return hour * 60 + minute


def _to_clock(minutes):
    """990 -> '16:30'. Midnight at the end of the day stays '24:00', not '00:00'."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _widen(window, addition):
    """Union of two (start, end) minute ranges, either of which may be None."""
    if not addition:
        return window
    if not window:
        return addition
    return (min(window[0], addition[0]), max(window[1], addition[1]))


def _display_time(clock):
    """'16:30' -> '4:30pm', the format the frontend shows and sorts on."""
    minutes = _to_minutes(clock) % (24 * 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour % 12 or 12}:{minute:02d}{'am' if hour < 12 else 'pm'}"


def _describe_room(name, location, href):
    """Pull the sortable/displayable pieces out of LibCal's free-text name."""
    match = ROOM_NAME_RE.match(name)
    # location reads "Library Study Rooms | Lower Level"; the level is the tail.
    level = location.split("|")[-1].strip() if "|" in location else location
    # Newer listings prefix the campus ("La Mirada - Lower Level"); every room
    # here is La Mirada, so keep just the level.
    level = re.sub(r"^\s*La Mirada\s*[-–]\s*", "", level, flags=re.IGNORECASE)
    return {
        "id": int(re.search(r"/space/(\d+)", href).group(1)),
        "code": match.group("code") if match else name,
        "capacity": (match.group("capacity") or "").strip() if match else "",
        "level": level,
        # A few rooms carry presentation equipment, which is worth knowing before you walk over.
        "presentation": "presentation" in name.lower(),
        "name": name,
        "location": location,
        "url": f"https://biola.libcal.com{href}",
    }


def _fetch_availability_via_api(page, context, eid):
    """
    Ask LibCal for the JSON its own availability grid is drawn from.

    One POST returns every slot for every room in the group. A slot is open
    when it carries no CSS class; any class (s-lc-eq-checkout,
    s-lc-eq-r-unavailable, ...) means booked or closed.

    Returns ({item_id: ["15:00", ...]}, (window_start, window_end)).
    """
    # springyPage is the config blob LibCal renders into every space page.
    config = page.evaluate(
        "() => ({ lid: springyPage.locationId, gid: springyPage.groupId,"
        " zone: springyPage.zoneId, pageSize: springyPage.pageSize })"
    )

    # LibCal trims the response to slots that are still bookable, so the window
    # it returns is "now through closing" and past times never come back.
    today = datetime.now(CAMPUS_TZ)
    response = context.request.post(
        "https://biola.libcal.com/spaces/availability/grid",
        form={
            "lid": str(config["lid"]),
            "gid": str(config["gid"]),
            "eid": str(eid),
            "seat": "0",
            "seatId": "0",
            "zone": str(config["zone"] or 0),
            "start": today.strftime("%Y-%m-%d"),
            "end": (today + timedelta(days=1)).strftime("%Y-%m-%d"),
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

    # Slots are keyed by time of day below, so a stray slot from another date
    # would land on today's board. Keep only today's.
    date_prefix = today.strftime("%Y-%m-%d")
    slots = [
        slot for slot in response.json().get("slots") or []
        if str(slot.get("start", "")).startswith(date_prefix)
    ]
    if not slots:
        raise RuntimeError("availability grid returned no slots")

    availability = {}
    for slot in slots:
        item_id = slot.get("itemId")
        if item_id is None:
            continue
        availability.setdefault(item_id, [])
        if not slot.get("className"):
            availability[item_id].append(slot["start"][11:16])

    # The window spans every slot, open or not, so the board's ruler covers the
    # whole remaining day rather than only the times that happen to be free.
    # It is derived from slot starts because the final slot's end wraps to
    # "00:00" and would sort below every other time.
    starts = [_to_minutes(s["start"][11:16]) for s in slots]
    return availability, (min(starts), max(starts) + SLOT_MINUTES)


def _fetch_availability_via_dom(page):
    """
    Fallback for one room page if the JSON endpoint ever changes.

    FullCalendar 6 dropped the `title` attribute the original scraper read, so
    match each slot block to the timeline column it sits over by pixel
    position. Returns (["15:00", ...], (window_start, window_end)).
    """
    result = page.evaluate(
        """() => {
            // One <td> per half-hour column, each tagged with the time it covers.
            const columns = [...document.querySelectorAll('.fc-timeline-slot-lane[data-date]')]
                .map(el => {
                    const box = el.getBoundingClientRect();
                    return { left: box.left, right: box.right, date: el.dataset.date };
                })
                .filter(col => col.right > col.left);
            if (!columns.length) return { open: [], covered: [] };

            const columnAt = (el) => {
                const box = el.getBoundingClientRect();
                const center = box.left + box.width / 2;
                return columns.find(col => center >= col.left && center < col.right);
            };
            const clock = (col) => col.date.slice(11, 16);

            const open = [];
            const covered = [];
            // Every block, free or booked, defines the day's bookable window.
            for (const event of document.querySelectorAll('.fc-timeline-event')) {
                const col = columnAt(event);
                if (!col) continue;
                covered.push(clock(col));
                if (event.classList.contains('s-lc-eq-avail')) open.push(clock(col));
            }
            return { open: [...new Set(open)].sort(), covered: [...new Set(covered)].sort() };
        }"""
    )
    covered = [_to_minutes(clock) for clock in result["covered"]]
    window = (min(covered), max(covered) + SLOT_MINUTES) if covered else None
    return result["open"], window


def _discover_rooms(page, base_url):
    """Read the La Mirada room list off LibCal's 'search by space' results."""
    page.goto(f"{base_url}?m=s&search=&gid={GROUP_ID}&capacity=0&zone=0", wait_until="networkidle")
    page.wait_for_selector("text=Matches", timeout=15000)

    rooms, skipped = [], 0
    for element in page.locator(".s-lc-booking-suggestion").all():
        try:
            link = element.locator("h3.media-heading a")
            if link.count() == 0:
                continue
            href = link.get_attribute("href")
            if not href or "/space/" not in href:
                continue

            name = link.inner_text().strip()
            group = element.locator(".s-lc-booking-group")
            location = group.inner_text().strip().replace("\n", " ") if group.count() else "Unknown location"

            # Talbot Phoenix shares this LibCal group; we only want La Mirada.
            if EXCLUDED_CAMPUS_RE.search(name) or EXCLUDED_CAMPUS_RE.search(location):
                skipped += 1
                continue

            rooms.append(_describe_room(name, location, href))
        except Exception as e:
            print(f"Warning: skipped a room due to parse error: {e}")
    return rooms, skipped


def stream_study_rooms(base_url="https://biola.libcal.com/reserve/studyroom"):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # A standard user agent avoids tripping LibCal's bot protection.
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            # The DOM fallback reads times off LibCal's calendar, which draws in
            # the browser's zone; keep it on campus time like everything else.
            timezone_id="America/Los_Angeles",
        )
        page = context.new_page()

        yield {"status": "progress", "progress": 10, "message": "Opening LibCal"}
        rooms, skipped = _discover_rooms(page, base_url)

        if not rooms:
            browser.close()
            yield {"status": "error", "message": "No study rooms listed on LibCal right now."}
            return

        yield {
            "status": "progress",
            "progress": 40,
            "message": f"Found {len(rooms)} rooms in La Mirada"
                       + (f", skipped {skipped} in Phoenix" if skipped else ""),
        }

        # Open one room page so LibCal hands us a session, then pull the whole
        # group's schedule in a single request.
        first = rooms[0]
        page.goto(first["url"], wait_until="domcontentloaded")
        page.wait_for_selector(".fc-timeline-event", timeout=15000)

        yield {"status": "progress", "progress": 65, "message": "Reading today's bookings"}

        window = None
        try:
            availability, window = _fetch_availability_via_api(page, context, first["id"])
            for room in rooms:
                room["open_slots"] = sorted(availability.get(room["id"], []))
        except Exception as e:
            print(f"Warning: availability API failed ({e}); falling back to DOM parsing.")
            for i, room in enumerate(rooms):
                yield {
                    "status": "progress",
                    "progress": 65 + int(30 * (i / len(rooms))),
                    "message": f"Reading {room['code']}",
                }
                try:
                    if i > 0:
                        page.goto(room["url"], wait_until="domcontentloaded")
                    # The grid skeleton renders before its events arrive, so wait
                    # for a slot block rather than just the hour labels.
                    page.wait_for_selector(".fc-timeline-event", timeout=10000)
                    room["open_slots"], room_window = _fetch_availability_via_dom(page)
                    window = _widen(window, room_window)
                except Exception as e:
                    print(f"Warning: could not read {room['code']}: {e}")
                    room["open_slots"] = []

        browser.close()

    if not window:
        yield {"status": "error", "message": "LibCal returned no schedule. Try again in a moment."}
        return

    for room in rooms:
        room["available_times"] = [_display_time(slot) for slot in room["open_slots"]]

    yield {
        "status": "done",
        "progress": 100,
        "data": rooms,
        "window": {"start": _to_clock(window[0]), "end": _to_clock(window[1])},
        "generated_at": datetime.now(CAMPUS_TZ).isoformat(timespec="seconds"),
    }


if __name__ == "__main__":
    print("Checking Biola study rooms...\n")
    try:
        for step in stream_study_rooms():
            if step["status"] == "error":
                print(f"Error: {step['message']}")
                sys.exit(1)
            if step["status"] != "done":
                continue

            rooms = step["data"]
            width = max(len(room["code"]) for room in rooms)
            for room in rooms:
                times = ", ".join(room["available_times"]) or "no openings left today"
                print(f"{room['code']:<{width}}  {room['level']:<12}  {times}")

            open_count = sum(1 for room in rooms if room["open_slots"])
            print(f"\n{open_count} of {len(rooms)} rooms have time open "
                  f"between {_display_time(step['window']['start'])} and "
                  f"{_display_time(step['window']['end'])}.")
    except BaseException as e:
        print(f"Error running the scraper: {e}")
        print("\nInstall Playwright and its browser first:")
        print("    pip install playwright")
        print("    playwright install chromium")
        sys.exit(1)
