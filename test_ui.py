"""Drives the demo in a real browser: draws a polygon, checks the selected list
against an independently-computed expectation, then exercises the three CRM sync
cases (add / remove / move). Screenshots each step."""
import json, os, re, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
# ?demo=1 pins the page to the 24 built-in stores. Without it, an exported
# map-data.js sitting next to the file would silently replace the data set these
# assertions describe.
HTML = "file://" + os.path.join(HERE, "store-map-demo.html") + "?demo=1"
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)

PASS = FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print("  ok   " + name)
    else:
        FAIL += 1; print("  FAIL " + name + (("  ->  " + str(extra)) if extra else ""))

def point_in_polygon(pt, poly):
    """Independent re-implementation, written from the definition rather than
    copied from the page, so it is a real cross-check of the shipped engine."""
    if len(poly) < 3:
        return False
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]["lng"], poly[i]["lat"]
        xj, yj = poly[j]["lng"], poly[j]["lat"]
        if (yi > pt["lat"]) != (yj > pt["lat"]):
            if pt["lng"] < (xj - xi) * (pt["lat"] - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))   # must be attached BEFORE goto
    page.goto(HTML)
    page.wait_for_selector("#offline svg circle")
    shot = lambda n: page.screenshot(path=os.path.join(SHOTS, n))

    # Clustering merges nearby pins, so turn it off while counting one-pin-per-store.
    # It gets its own section at the bottom, at the real 2,000-store scale.
    page.uncheck("#clusterBox")

    # ---------- baseline ----------
    # Control positive for ?demo=1. "24 stores" also passes on a machine that has no
    # export at all, which would make the switch look tested when it never ran. This
    # says out loud whether the thing it overrides was actually present.
    export = os.path.join(HERE, "map-data.js")
    if os.path.exists(export):
        ok("?demo=1 overrode a real export that is on disk", True)
    else:
        print("  ..   no map-data.js on disk - ?demo=1 was not exercised")

    total = len(page.query_selector_all("#offline svg circle"))
    ok("24 demo stores rendered as markers", total == 24, f"got {total}")
    ok("selection starts empty", page.text_content("#selCount") == "0")
    shot("1-loaded.png")

    # ---------- draw a polygon ----------
    box = page.locator("#offline").bounding_box()
    page.click("#drawBtn")
    for fx, fy in [(0.18, 0.20), (0.62, 0.16), (0.68, 0.58), (0.22, 0.62)]:
        page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
    page.click("#drawBtn")  # finish

    poly = page.evaluate("polygon")
    all_stores = page.evaluate("stores.map(s => ({id:s.id, name:s.name, lat:s.lat, lng:s.lng, cat:s.cat}))")
    ok("polygon has 4 vertices", len(poly) == 4, f"got {len(poly)}")

    expected = sorted(s["name"] for s in all_stores if point_in_polygon(s, poly))
    shown = sorted(e.text_content() for e in page.query_selector_all("#selList .store b"))
    ok("polygon selected a non-empty set (control positive)", len(expected) > 0, len(expected))
    ok("list matches an independent point-in-polygon calc", shown == expected,
       f"ui={shown} calc={expected}")
    ok("counter matches the list", page.text_content("#selCount") == str(len(expected)),
       f'counter={page.text_content("#selCount")} list={len(expected)}')
    print(f"       ({len(expected)} of 24 stores inside the polygon)")
    shot("2-polygon-selection.png")

    # ---------- CRM sync: ADD a store inside the polygon ----------
    inside = next(s for s in all_stores if s["name"] == expected[0])
    page.fill("#nName", "Nueva Tienda CRM")
    page.fill("#nLat", str(inside["lat"]))
    page.fill("#nLng", str(inside["lng"]))
    page.click("#addStore")
    after_add = [e.text_content() for e in page.query_selector_all("#selList .store b")]
    ok("store added in the CRM appears in the selection", "Nueva Tienda CRM" in after_add, after_add)
    ok("counter incremented on add", page.text_content("#selCount") == str(len(expected) + 1))
    ok("marker count incremented on add",
       len(page.query_selector_all("#offline svg circle")) == total + 1 + len(poly),
       "markers + polygon vertices")
    shot("3-after-add.png")

    # ---------- CRM sync: MOVE it outside ----------
    new_id = page.evaluate("stores[stores.length-1].id")
    page.evaluate("id => moveStore(id, 40.470, -3.640)", new_id)
    after_move = [e.text_content() for e in page.query_selector_all("#selList .store b")]
    ok("moving a store out of the polygon deselects it", "Nueva Tienda CRM" not in after_move)
    ok("counter back to the original count", page.text_content("#selCount") == str(len(expected)))

    # ---------- CRM sync: REMOVE ----------
    page.evaluate("id => removeStore(id)", new_id)
    ok("removed store is gone from the map",
       len(page.query_selector_all("#offline svg circle")) == total + len(poly))

    # ---------- category filter ----------
    page.uncheck('#legend input[data-cat="active"]')
    filtered = sorted(e.text_content() for e in page.query_selector_all("#selList .store b"))
    cats = {s["name"]: s["cat"] for s in all_stores}
    want = sorted(n for n in expected if cats[n] != "active")
    ok("hiding a category drops those stores from the selection", filtered == want,
       f"ui={filtered} want={want}")
    ok("hiding a category actually changed something (control positive)", want != expected,
       "the polygon contained no Active stores - test is vacuous")
    shot("4-category-filtered.png")
    page.check('#legend input[data-cat="active"]')

    # ---------- clear ----------
    page.click("#clearBtn")
    ok("clear resets the selection", page.text_content("#selCount") == "0")
    ok("clear removes the polygon from the map",
       len(page.query_selector_all("#offline svg polygon")) == 0)

    # ---------- pins Google was unsure about ----------
    # The point of storing Google's confidence is that nobody checks 2,000 pins by
    # eye. What must be true is that the short list is the RIGHT short list.
    print("\npins worth checking")
    flagged = page.evaluate("stores.filter(needsReview).map(s => s.name).sort()")
    ok("some pins are flagged for review (control positive)", len(flagged) > 0, flagged)
    ok("but not all of them — that would be useless",
       len(flagged) < page.evaluate("stores.length"), flagged)
    ok("the sidebar count matches the data",
       page.text_content("#reviewCount") == str(len(flagged)),
       f'ui={page.text_content("#reviewCount")} data={len(flagged)}')
    ok("only imprecise geocodes are flagged",
       page.evaluate("stores.filter(isVague)"
                     ".every(s => ['APPROXIMATE','GEOMETRIC_CENTER'].includes(s.prec))"))
    ok("precise pins are not flagged",
       page.evaluate("stores.filter(s => s.prec === 'ROOFTOP').every(s => !needsReview(s))"))
    ok("nothing is stale yet, so this list is purely about precision",
       page.evaluate("stores.every(s => !isStale(s))"))

    page.check("#reviewBox")
    shown_names = sorted(page.evaluate("visibleStores().map(s => s.name)"))
    ok("the filter shows exactly the flagged pins", shown_names == flagged,
       f"ui={shown_names} want={flagged}")
    drawn = len(page.query_selector_all("#offline svg circle.pin"))
    ok("and the map draws only those", drawn == len(flagged), f"drawn={drawn} want={len(flagged)}")
    # Hollow, not a different colour: the category colour still has to be readable.
    ok("flagged pins are drawn hollow",
       all(c.get_attribute("fill") == "none"
           for c in page.query_selector_all("#offline svg circle.pin")))
    shot("9-needs-review.png")
    page.uncheck("#reviewBox")
    ok("unticking restores every pin",
       len(page.query_selector_all("#offline svg circle.pin")) == total,
       len(page.query_selector_all("#offline svg circle.pin")))

    # ---------- manual correction: drag a pin ----------
    # Geocoding is never perfect, so a person has to be able to drag a pin onto the
    # right spot. The thing that must be true is that the drag lands where the mouse
    # was released - not merely that "something moved".
    print("\ndrag a pin to correct its position")

    # The offline surface's projection, re-derived here from its bounds rather than
    # read out of the page, so a wrong projection would show up as a failure.
    B = {"minLat": 40.360, "maxLat": 40.478, "minLng": -3.775, "maxLng": -3.625}
    box = page.locator("#offline").bounding_box()
    to_lat = lambda py: B["maxLat"] - (py / box["height"]) * (B["maxLat"] - B["minLat"])
    to_lng = lambda px: B["minLng"] + (px / box["width"]) * (B["maxLng"] - B["minLng"])

    ok("nothing is pending undo before the first drag", not page.is_visible("#undoBtn"))

    # Pick a pin with no neighbour on top of it. Madrid's centre has stores 60 m
    # apart, which overlap at this zoom - grabbing one of those drags whichever
    # circle the browser painted last, so the test would be about a store other
    # than the one it names.
    sid = page.evaluate("stores.find(s => s.name === 'Legazpi').id")
    pin = page.query_selector(f'#offline svg circle.pin[data-sid="{sid}"]')
    before = page.evaluate("id => { const s = stores.find(x=>x.id===id); return {lat:s.lat, lng:s.lng, src:s.src}; }", sid)
    ok("a pin starts out marked as geocoded, not manual", before["src"] == "geocoded", before)

    pb = pin.bounding_box()
    grab = [pb["x"] + pb["width"] / 2, pb["y"] + pb["height"] / 2]
    top = page.evaluate("([x,y]) => { const e = document.elementFromPoint(x,y);"
                        "return e && e.getAttribute('data-sid'); }", grab)
    ok("the pin under the cursor really is the one being tested", top == str(sid),
       f"grabbing sid={sid} but the topmost element is sid={top}")

    # Whole pixels. The browser truncates mouse coordinates to integers, so a
    # fractional target would leave the expectation ~1 px off the position the page
    # actually receives - and a loose tolerance to absorb that would hide a real
    # projection bug of the same size.
    tx = float(round(box["x"] + box["width"] * 0.40))
    ty = float(round(box["y"] + box["height"] * 0.72))
    page.mouse.move(grab[0], grab[1])
    page.mouse.down()
    page.mouse.move(tx, ty, steps=12)
    page.mouse.up()

    after = page.evaluate("id => { const s = stores.find(x=>x.id===id); return {lat:s.lat, lng:s.lng, src:s.src}; }", sid)
    want_lat, want_lng = to_lat(ty - box["y"]), to_lng(tx - box["x"])
    ok("the pin actually moved", after["lat"] != before["lat"] or after["lng"] != before["lng"], after)
    # 1e-7 degrees is about a centimetre: tight enough that a one-pixel projection
    # error fails this, which is the whole point of correcting a pin by hand.
    ok("it landed where the mouse was released, not somewhere else",
       abs(after["lat"] - want_lat) < 1e-7 and abs(after["lng"] - want_lng) < 1e-7,
       f"got={after} want=({want_lat:.7f}, {want_lng:.7f})")
    ok("the drag marked the store as manually placed", after["src"] == "manual", after)

    counted = page.evaluate("stores.filter(s => s.src === 'manual').length")
    ok("exactly one store is marked manual, not all of them", counted == 1, counted)
    ok("the sidebar reports the adjusted count", "1 store adjusted" in page.text_content("#manualNote"),
       page.text_content("#manualNote"))

    # Select the store we just moved, so the "adjusted" badge is exercised in the
    # list (and visible in the screenshot) rather than only in the data.
    page.click("#drawBtn")
    for dx, dy in [(-70, -70), (70, -70), (70, 70), (-70, 70)]:
        page.mouse.click(tx + dx, ty + dy)
    page.click("#drawBtn")
    # A drag fires a click of its own on release, which the map has to swallow so it
    # does not become a stray vertex. Swallowing one click too many is the same bug
    # in the other direction: the first vertex after any drag goes missing, and the
    # user just sees a click that did nothing.
    ok("the first polygon vertex after a drag is not swallowed",
       len(page.evaluate("polygon")) == 4, page.evaluate("polygon.length"))
    ok("the adjusted store shows an 'adjusted' badge in the list",
       page.query_selector("#selList .badge") is not None,
       page.inner_html("#selList")[:200])
    page.eval_on_selector("aside.left", "e => e.scrollTop = e.scrollHeight")
    shot("8-pin-dragged.png")
    page.click("#clearBtn")

    # Undo. A drag is a mouse gesture with no confirmation step, so an accidental one
    # must be reversible - otherwise correcting pins by hand is a one-way door.
    ok("an undo button appears after a move", page.is_visible("#undoBtn"))
    page.click("#undoBtn")
    restored = page.evaluate("id => { const s = stores.find(x=>x.id===id); return {lat:s.lat, lng:s.lng, src:s.src}; }", sid)
    ok("undo puts the pin back exactly where it was",
       restored["lat"] == before["lat"] and restored["lng"] == before["lng"], restored)
    ok("undo also clears the manual flag", restored["src"] == "geocoded", restored)
    ok("the undo button goes away once used", not page.is_visible("#undoBtn"))

    # While the polygon tool is armed, press-and-drag means "draw", so pins must not
    # move. Both gestures are a mousedown on the map; getting this wrong would yank a
    # store across the city every time someone drew a polygon over it.
    page.click("#drawBtn")
    pin2 = page.query_selector("#offline svg circle.pin[data-sid]")
    sid2 = int(pin2.get_attribute("data-sid"))
    pre = page.evaluate("id => { const s = stores.find(x=>x.id===id); return {lat:s.lat, lng:s.lng}; }", sid2)
    pb2 = pin2.bounding_box()
    page.mouse.move(pb2["x"] + pb2["width"] / 2, pb2["y"] + pb2["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.85, box["y"] + box["height"] * 0.85, steps=8)
    page.mouse.up()
    post = page.evaluate("id => { const s = stores.find(x=>x.id===id); return {lat:s.lat, lng:s.lng}; }", sid2)
    ok("dragging is disabled while the polygon tool is active",
       post["lat"] == pre["lat"] and post["lng"] == pre["lng"], f"pre={pre} post={post}")
    page.click("#drawBtn")
    page.click("#clearBtn")

    # ---------- renaming a store vs changing its address ----------
    # The client asked what happens to a pin when a store is renamed. The answer is
    # "nothing", and it is worth driving rather than asserting: the coordinates hang
    # off the store's id, not off any text a user can retype. The dangerous sibling
    # is the ADDRESS edit, where the pin stays on the old street looking correct.
    print("\nrenaming a store, and changing its address")

    # Draw a selection first, and rename a store that is INSIDE it. Otherwise
    # "selection membership is unchanged" is only ever comparing False to False.
    page.click("#drawBtn")
    for fx, fy in [(0.10, 0.10), (0.90, 0.10), (0.90, 0.90), (0.10, 0.90)]:
        page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
    page.click("#drawBtn")
    # An ISOLATED pin, not just the first selected one. Gran Vía 34 and Callao sit
    # 60 m apart and overlap on screen, so a screenshot of a ring around one of them
    # proves nothing about which store it belongs to.
    target = page.evaluate(
        "(() => { const s = stores.find(x => x.name === 'Legazpi' && selectedIds.has(x.id));"
        "         return s ? s.id : [...selectedIds][0]; })()")
    ok("control positive: the store about to be renamed is inside the selection",
       target is not None and page.evaluate("id => selectedIds.has(id)", target), target)
    page.select_option("#editTarget", str(target))
    read = lambda i: page.evaluate(
        "id => { const s = stores.find(x=>x.id===id);"
        "        return {lat:s.lat, lng:s.lng, name:s.name, addr:s.addr,"
        "                locAddr:s.locAddr, stale:isStale(s), src:s.src}; }", i)
    before = read(target)
    # Captured BEFORE the rename. Comparing a live read against another live read
    # would be a tautology that passes no matter what the rename does.
    was_selected = page.evaluate("id => selectedIds.has(id)", target)

    page.fill("#editName", "Ani India")
    page.click("#renameBtn")
    after = read(target)
    ok("renaming a store does not move its pin",
       after["lat"] == before["lat"] and after["lng"] == before["lng"], f"{before} -> {after}")
    ok("...the rename did take effect (control positive)", after["name"] == "Ani India", after)
    ok("...and the pin is not marked stale by a rename", after["stale"] is False, after)
    ok("...and its polygon selection membership is unchanged",
       page.evaluate("id => selectedIds.has(id)", target) == was_selected,
       f"was={was_selected} now={page.evaluate('id => selectedIds.has(id)', target)}")

    # The marker on the map must be the same marker, not a torn-down and rebuilt one.
    same_pin = page.query_selector(f'#offline svg circle.pin[data-sid="{target}"]')
    ok("...and it still has exactly one pin on the map, under the same id",
       same_pin is not None and
       len(page.query_selector_all(f'#offline svg circle.pin[data-sid="{target}"]')) == 1)

    # Now the address.
    page.fill("#editAddr", "Calle Nueva 5, Madrid")
    page.click("#addrBtn")
    moved = read(target)
    ok("changing the address marks the pin stale", moved["stale"] is True, moved)
    ok("...but does not move the pin on its own",
       moved["lat"] == before["lat"] and moved["lng"] == before["lng"], moved)
    ok("...and the pin still records the address it was actually placed for",
       moved["locAddr"] == before["addr"], moved)
    ok("a stale pin gets a ring on the map",
       len(page.query_selector_all(f'#offline svg circle.ring[data-sid="{target}"]')) == 1)
    ok("...and the ring is decoration, so it cannot be dragged instead of the pin",
       page.get_attribute(f'#offline svg circle.ring[data-sid="{target}"]',
                          "pointer-events") == "none")
    ok("a stale pin joins the list of pins worth checking",
       page.evaluate("id => needsReview(stores.find(x=>x.id===id))", target) is True)
    shot("10-address-changed.png")

    # Re-geocoding the changed ones. This stands in for --refresh-changed.
    # First make one of them a hand-placed pin, which the run must refuse to touch.
    hand = page.evaluate("stores.filter(s => s.id !== %d)[0].id" % target)
    page.evaluate("id => moveStore(id, 40.40, -3.70, {manual:true})", hand)
    page.select_option("#editTarget", str(hand))
    page.fill("#editAddr", "Otra Calle 9, Madrid")
    page.click("#addrBtn")
    ok("control positive: the hand-placed pin is stale too", read(hand)["stale"] is True, read(hand))

    stale_before = page.evaluate("stores.filter(isStale).length")
    ok("control positive: there are stale pins to re-geocode", stale_before == 2, stale_before)
    pre_hand = read(hand)
    page.click("#refreshBtn")
    post = read(target)
    post_hand = read(hand)
    ok("re-geocoding moves the machine-placed pin to its new address",
       post["stale"] is False and post["lat"] != before["lat"], post)
    ok("...and leaves the hand-placed pin exactly where the person put it",
       post_hand["lat"] == pre_hand["lat"] and post_hand["lng"] == pre_hand["lng"], post_hand)
    ok("...still marked manual, so it keeps its protection",
       post_hand["src"] == "manual", post_hand)
    ok("...and still flagged, because only a person can resolve it",
       post_hand["stale"] is True, post_hand)
    ok("the sidebar says how many pins are on a changed address",
       "1 pin is" in (page.text_content("#staleNote") or ""), page.text_content("#staleNote"))

    # Put the map back the way the scale section expects it.
    page.evaluate("id => moveStore(id, %f, %f)" % (pre_hand["lat"], pre_hand["lng"]), hand)
    page.evaluate("stores.forEach(s => { s.addr = s.locAddr || s.addr; }); recompute()")
    ok("cleanup: nothing is stale going into the scale section",
       page.evaluate("stores.filter(isStale).length") == 0)
    page.click("#clearBtn")

    # ---------- real scale: 2,000 stores ----------
    # The client's database holds ~2,000 stores in 3 categories. Everything above
    # runs on 24. This section measures the real thing rather than assuming it scales.
    print("\n2,000-store scale")
    page.click("#bulkBtn")
    n = page.evaluate("stores.length")
    ok("2,000 stores loaded", n == 2000, n)

    ids = page.evaluate("stores.map(s => s.id)")
    ok("every store has a unique id", len(set(ids)) == 2000, len(set(ids)))

    # Cluster the lot and prove no pin is lost or double-counted.
    page.check("#clusterBox")
    cl = page.evaluate("""() => {
        const pts = stores.map(s => ({id:s.id, x:s.lng*10000, y:s.lat*10000}));
        const g = clusterPoints(pts, 48);
        const seen = new Set();
        let dupes = 0;
        for (const c of g) for (const it of c.items) { if (seen.has(it.id)) dupes++; seen.add(it.id); }
        return {groups: g.length, covered: seen.size, dupes,
                summed: g.reduce((a,c) => a + c.count, 0)};
    }""")
    ok("clustering covers every single store", cl["covered"] == 2000, cl)
    ok("clustering never counts a store twice", cl["dupes"] == 0, cl)
    ok("cluster counts sum to the total", cl["summed"] == 2000, cl)
    ok("clustering actually groups (control positive)", cl["groups"] < 2000, cl)

    drawn_clustered = len(page.query_selector_all("#offline svg circle"))
    page.uncheck("#clusterBox")
    drawn_plain = len(page.query_selector_all("#offline svg circle"))
    ok("clustering draws far fewer shapes than one-per-store",
       drawn_clustered < drawn_plain / 2, f"clustered={drawn_clustered} plain={drawn_plain}")

    # Select a big chunk of the city and time it, unclustered = worst case.
    box = page.locator("#offline").bounding_box()
    page.click("#drawBtn")
    for fx, fy in [(0.10, 0.10), (0.90, 0.10), (0.90, 0.90), (0.10, 0.90)]:
        page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
    page.click("#drawBtn")

    perf = page.evaluate("window.__perf")
    sel_count = int(page.text_content("#selCount"))
    ok("a city-wide polygon selects a large set (control positive)", sel_count > 500, sel_count)
    ok(f'selection over 2,000 stores stays under 50 ms (was {perf["selectMs"]} ms)',
       perf["selectMs"] < 50, perf)
    ok(f'redraw of 2,000 pins stays under 400 ms (was {perf["renderMs"]} ms)',
       perf["renderMs"] < 400, perf)

    poly2 = page.evaluate("polygon")
    big = page.evaluate("stores.map(s => ({id:s.id, lat:s.lat, lng:s.lng}))")
    expect_big = sum(1 for s in big if point_in_polygon(s, poly2))
    ok("2,000-store selection matches the independent calc", sel_count == expect_big,
       f"ui={sel_count} calc={expect_big}")

    note = page.text_content("#listNote")
    ok("long selections say the list is truncated", "Export CSV" in note, note)
    ok("the list itself is capped, not rendering 1,000+ rows",
       len(page.query_selector_all("#selList .store")) <= 200,
       len(page.query_selector_all("#selList .store")))

    page.check("#clusterBox")
    shot("5-2000-stores-clustered.png")
    print(f'       ({sel_count} of 2,000 selected · select {perf["selectMs"]} ms · '
          f'draw {perf["renderMs"]} ms · {cl["groups"]} clusters)')

    ok("no uncaught javascript errors on the page", not errors, errors)
    browser.close()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
