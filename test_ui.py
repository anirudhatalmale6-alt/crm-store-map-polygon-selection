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

    page.select_option("#reviewMode", "only")
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

    # ---------- "Hide pins to check" ----------
    # His words: "sometime is better to avoid unsecure pins and we might want to avoid
    # them". Avoiding them means they must not come back in the EXPORT either - hiding
    # a pin on screen while still writing it to the CSV would be worse than no filter,
    # because he would post to those addresses believing he had excluded them.
    all_names = page.evaluate("stores.map(s => s.name)")
    page.select_option("#reviewMode", "hide")
    kept = sorted(page.evaluate("visibleStores().map(s => s.name)"))
    ok("hiding shows exactly the pins that are NOT flagged",
       kept == sorted(set(all_names) - set(flagged)), f"ui={kept}")
    ok("the two modes are exact complements — no store falls through either",
       sorted(kept + flagged) == sorted(all_names))
    ok("and the map draws only the kept ones",
       len(page.query_selector_all("#offline svg circle.pin")) == len(kept))
    # data-sid is a STRING and store ids are NUMBERS, so this has to coerce. Written
    # with === it silently compared against undefined and threw inside needsReview.
    ok("every drawn pin still resolves to a real store",
       page.evaluate("[...document.querySelectorAll('#offline svg [data-sid]')]"
                     ".every(e => stores.some(s => String(s.id) === e.dataset.sid))"))
    ok("no hidden pin is left drawn under another name",
       page.evaluate("[...document.querySelectorAll('#offline svg [data-sid]')]"
                     ".every(e => !needsReview(stores.find(s => String(s.id) === e.dataset.sid)))"))

    # The leak that a rendering-only filter would have: select everything, then read
    # what the CSV would actually contain.
    page.evaluate("polygon = OfflineSurface.bounds ? "
                  "[{lat:-89,lng:-179},{lat:-89,lng:179},{lat:89,lng:179},{lat:89,lng:-179}] : polygon;"
                  "recompute();")
    sel_csv = page.evaluate("csvOf(stores.filter(s => selectedIds.has(s.id)))")
    ok("a whole-world polygon selects only the kept pins",
       page.evaluate("selectedIds.size") == len(kept), page.evaluate("selectedIds.size"))
    ok("and NO flagged store appears anywhere in the CSV text",
       not any(n in sel_csv for n in flagged), [n for n in flagged if n in sel_csv][:3])
    # Control positive: with the filter off, that same polygon DOES export them.
    page.select_option("#reviewMode", "all")
    page.evaluate("recompute()")
    all_csv = page.evaluate("csvOf(stores.filter(s => selectedIds.has(s.id)))")
    ok("control positive: with the filter off the same polygon exports them",
       all(n in all_csv for n in flagged), [n for n in flagged if n not in all_csv][:3])
    page.evaluate("polygon = []; selectedIds = new Set(); recompute();")

    ok("going back to Show all restores every pin",
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

    # ---------- the grouping toggle has to be FINDABLE, not merely present ----------
    # The customer asked for a control that already existed and had worked from the
    # first version. It sat in the fourth sidebar section, 625px below the fold behind
    # two simulator panels, so in practice it did not exist. Every behavioural
    # assertion above stayed green throughout, because Playwright reaches a control by
    # selector whether or not a human could ever have found it. Hence: assert it is on
    # screen without scrolling, and that it is the thing under its own coordinates -
    # a floating toolbar or banner sitting over it would be the same bug again.
    vis = page.evaluate("""() => {
      const el = document.getElementById('clusterBox');
      const lab = el.closest('label');
      const r = lab.getBoundingClientRect();
      /* Sample the WHOLE label, not the middle of the checkbox. Checked once with the
         perf readout still pinned top-right: it printed itself straight across the
         words "Group nearby pins" while the box itself, over at the left edge, was
         perfectly clickable - so a probe at the checkbox's centre passed on a control
         whose name was unreadable. A covered LABEL is a control nobody finds, which is
         the entire bug being fixed here. */
      let covered = 0, pts = 0;
      for (let fx = 0.06; fx < 1; fx += 0.08) {
        const x = r.x + r.width * fx, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        pts++;
        if (!(hit === lab || lab.contains(hit))) covered++;
      }
      /* elementFromPoint alone is the WRONG INSTRUMENT here and passed the whole time
         the label was unreadable. The perf readout carries pointer-events:none, so a
         hit test looks straight THROUGH it and returns the label underneath - the
         probe reports "nothing covering it" about something printed right across it.
         Anything that paints over a control has to be caught geometrically, by
         overlapping rectangles, whether or not it can be clicked. */
      const overlaps = [...document.querySelectorAll('.perfbar, .banner')]
        .filter(o => !o.contains(lab) && !lab.contains(o))
        .filter(o => { const b = o.getBoundingClientRect();
          return b.width && b.height && b.left < r.right && b.right > r.left
                                     && b.top < r.bottom && b.bottom > r.top; })
        .map(o => o.className);
      return { top: Math.round(r.top), bottom: Math.round(r.bottom),
               vh: window.innerHeight, w: Math.round(r.width),
               onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
               covered, pts, overlaps,
               nearPolygonButton: Math.abs(
                 r.top - document.getElementById('drawBtn').getBoundingClientRect().top) < 40 };
    }""")
    ok("the grouping toggle is on screen without scrolling", vis["onScreen"], vis)
    ok("...and nothing is printed across its label",
       vis["covered"] == 0 and not vis["overlaps"], vis)
    ok("...and it sits with the polygon buttons, where it is wanted",
       vis["nearPolygonButton"], vis)

    # Same test for the review filter, for the same reason. Its natural home is the
    # "Pins worth checking" section, which measured 1,552px down a 665px panel - and he
    # has already told me once that a control down there is a "very hidden position".
    rv = page.evaluate("""() => {
      const els = [...document.querySelectorAll('#reviewMode')];
      const r = els[0].getBoundingClientRect();
      return { copies: els.length,
               onScreen: r.top >= 0 && r.bottom <= innerHeight
                      && r.left >= 0 && r.right <= innerWidth,
               nearPolygonButton: Math.abs(
                 r.top - document.getElementById('drawBtn').getBoundingClientRect().top) < 40 };
    }""")
    ok("the review filter is on screen without scrolling", rv["onScreen"], rv)
    ok("...and sits with the polygon buttons", rv["nearPolygonButton"], rv)
    # One control, one place: two of them would drift and show different modes.
    ok("...and there is exactly one of it on the page", rv["copies"] == 1, rv)

    # Grouping is a DISPLAY choice. If it ever changed what a polygon selects, the
    # count in the panel would depend on a checkbox about pictures - so both modes are
    # run over the same polygon and compared.
    # The box is derived from the data and padded, so it holds EVERY store. A polygon
    # over one district passes this by luck: whichever store a bug drops is probably
    # outside it anyway. Checked - with the selection deliberately made to depend on
    # the checkbox, a district-sized polygon still came back identical.
    same = page.evaluate("""() => {
      const la = stores.map(s => s.lat), ln = stores.map(s => s.lng);
      const p = 0.01, N = Math.max(...la)+p, S = Math.min(...la)-p,
                      E = Math.max(...ln)+p, W = Math.min(...ln)-p;
      const poly = [{lat:S,lng:W},{lat:S,lng:E},{lat:N,lng:E},{lat:N,lng:W}];
      const run = on => { clustering = on; polygon = poly.slice(); recompute();
                          return [...selectedIds].sort((a,b)=>a-b); };
      const grouped = run(true), plain = run(false);
      return { grouped: grouped.length, plain: plain.length, total: stores.length,
               identical: grouped.length === plain.length
                          && grouped.every((v,i) => v === plain[i]) };
    }""")
    ok("the same polygon selects the same stores grouped or not",
       same["identical"] and same["grouped"] > 0, same)
    ok("control positive: the box really did cover every store",
       same["grouped"] == same["total"], same)

    # ---------- click a pin, get the store ----------
    # Driven with a real mouse at real coordinates, not by calling the handler: the
    # thing being tested is that a click LANDS on the pin, and a synthetic call proves
    # nothing about whether anything is on top of it.
    page.click("#clearBtn")
    page.check("#clusterBox")
    page.uncheck("#clusterBox")
    pin = page.query_selector("#offline g.pin, #offline circle.pin")
    pbox = pin.bounding_box()
    page.mouse.click(pbox["x"] + pbox["width"] / 2, pbox["y"] + pbox["height"] / 2)
    page.wait_for_timeout(120)
    click = page.evaluate("""() => {
      const el = document.getElementById('card');
      const s = stores.find(x => x.id === window.__card);
      const t = el.textContent || '';
      return { shown: getComputedStyle(el).display !== 'none', id: window.__card,
               name: !!(s && t.includes(s.name)),
               phone: !!(s && s.phone && t.includes(s.phone)),
               addr: !!(s && s.addr && t.includes(s.addr)),
               mail: !!(s && (!s.mail ? t.includes('no e-mail on record') : t.includes(s.mail))),
               inside: (() => { const w = document.getElementById('mapwrap')
                                  .getBoundingClientRect(), b = el.getBoundingClientRect();
                 return b.left >= w.left - 1 && b.right <= w.right + 1
                     && b.top >= w.top - 1 && b.bottom <= w.bottom + 1; })() };
    }""")
    ok("clicking a pin opens its card", click["shown"] and click["id"] is not None, click)
    ok("...with the name, phone and address on it",
       click["name"] and click["phone"] and click["addr"], click)
    # A blank column and a broken card look identical. Says so rather than dropping it.
    ok("...and it says so when a field is empty rather than hiding the row",
       click["mail"], click)
    # A store on the coast is near the edge of the map; a card that opens half off the
    # screen reads as the click having failed.
    ok("...and the card stays inside the map", click["inside"], click)

    # Clicking empty map puts it away again.
    page.mouse.click(pbox["x"] + 240, pbox["y"] + 190)
    page.wait_for_timeout(120)
    ok("clicking away from a pin closes the card",
       page.evaluate("() => getComputedStyle(document.getElementById('card')).display === 'none'"))

    # Nudging a pin into place ends in a click. If that opened a card every time, the
    # correction would feel like a misfire.
    # The pin has to be RE-LOCATED first: the clicks above changed the drawing, so the
    # box measured earlier is stale. Without that, the "drag" lands on empty map, no
    # card opens because nothing was clicked, and the assertion passes having tested
    # nothing - which is exactly what it did until the mutation check caught it.
    # BOTH pin modes. A dot pin is the element carrying data-sid; an icon pin is a
    # group wrapping a path. Reading the event target directly worked in the first and
    # silently did nothing in the second, so dragging a pin - advertised in the sidebar
    # - had never worked with icon pins on, which is the mode the customer's artwork
    # runs in. Only the control positive exposed it: the old assertion passed because
    # the drag was not happening at all.
    for mode, on in (("dot", False), ("icon", True)):
        if on: page.check("#iconBox")
        else:  page.uncheck("#iconBox")
        page.wait_for_timeout(200)
        page.evaluate("() => hideCard()")
        sel = "#offline g.pin" if on else "#offline circle.pin"
        el = page.query_selector(sel)
        bb = el.bounding_box()
        # A teardrop is anchored at its point, so aim at the head, not the centre.
        cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] * (0.35 if on else 0.5)
        # WHICH pin is under those coordinates, not which one came first in the DOM.
        # The stress set is loaded by now, so pins overlap and the topmost one wins the
        # click. Assuming the first element in document order is the one being hit is
        # how this reported "the pin did not move" about a pin nobody touched.
        sid = page.evaluate("""(pt) => {
          const t = document.elementFromPoint(pt.x, pt.y);
          const el = t && t.closest && t.closest('[data-sid]');
          return el ? Number(el.dataset.sid) : null;
        }""", {"x": cx, "y": cy})
        ok(f"control positive: the {mode} click coordinates land on a pin",
           sid is not None, {"x": cx, "y": cy})
        if sid is None:
            continue
        pos = lambda: page.evaluate("id => { const s = stores.find(x => x.id === id);"
                                    "return [s.lat, s.lng]; }", sid)
        before_xy = pos()
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 30, cy + 20, steps=8)
        page.mouse.up()
        page.wait_for_timeout(150)
        moved = pos() != before_xy
        ok(f"a {mode} pin can be dragged to correct its position", moved,
           {"before": before_xy, "after": pos()})
        ok(f"...and that drag does NOT pop a card open ({mode})",
           moved and page.evaluate(
               "() => getComputedStyle(document.getElementById('card')).display === 'none'"))
        # And a plain click, in the same mode, must open the card for whichever pin is
        # actually on top at that point - which after a drag is not necessarily the one
        # just dropped there, because 2,000 stores overlap.
        under = page.evaluate("""(pt) => {
          const t = document.elementFromPoint(pt.x, pt.y);
          const el = t && t.closest && t.closest('[data-sid]');
          return el ? Number(el.dataset.sid) : null;
        }""", {"x": cx + 30, "y": cy + 20})
        page.mouse.click(cx + 30, cy + 20)
        page.wait_for_timeout(140)
        ok(f"...while a click opens the card for the pin under the cursor ({mode})",
           under is not None and page.evaluate("() => window.__card") == under,
           {"card": page.evaluate("() => window.__card"), "under": under})
        page.evaluate("() => hideCard()")
    page.uncheck("#iconBox")

    # ---------- the check-these ring is quiet on the map, loud in review ----------
    # "Aesthetically overwhelming the rest" - 570 of 2,423 stores carry this mark, so
    # it cannot shout. Measured as ink: pixels the ring adds over a plain pin.
    # The ring only exists on ARTWORK pins - a drawn pin says "imprecise" by going
    # hollow, which needs no ring. The demo set carries no artwork, so this attaches a
    # fixture one; without it this whole block measures the built-in pin and reports a
    # confident zero about a feature it never reached.
    weight = page.evaluate("""() => {
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
                + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const c = { id:'__ring', label:'Ring', color:'#868686', glyph: GLYPH.star,
                  art: { w:64, h:88, head:{cx:0.5, cy:0.2955, r:0.5}, art: PNG } };
      ART_STATE.set('__ring', 'ok');
      const len = svg => (svg.match(/<circle/g) || []).length;
      const w = svg => [...svg.matchAll(/stroke-width="([\\d.]+)"/g)]
                        .reduce((a, m) => a + Number(m[1]), 0);
      const was = reviewMode;
      reviewMode = 'all';  const quiet = pinSvg(c, { hollow: true });
      reviewMode = 'only'; const loud  = pinSvg(c, { hollow: true });
      reviewMode = was;
      const plain = pinSvg(c);
      ART_STATE.delete('__ring');
      return { quietRings: len(quiet) - len(plain), loudRings: len(loud) - len(plain),
               quietInk: w(quiet) - w(plain), loudInk: w(loud) - w(plain),
               plainHasNoRing: len(plain) === 0 };
    }""")
    ok("an imprecise pin is still marked on the normal map",
       weight["quietRings"] == 2 and weight["quietInk"] > 0, weight)
    ok("...but noticeably lighter than it is in review mode",
       weight["quietInk"] < weight["loudInk"] * 0.75, weight)
    ok("control positive: a precise pin carries no ring at all",
       weight["plainHasNoRing"], weight)

    # ---------- a confident pin in the wrong town ----------
    # Every other warning comes from Google grading its own answer, which cannot catch
    # a confident ROOFTOP hit on a building in the wrong town. This checks Google
    # against something Google never saw: where the OTHER stores in that town are.
    town = page.evaluate("""() => {
      // A town of four identical stores, plus one dropped 40 km away.
      const base = { lat: 41.0, lng: -4.0 };
      const mk2 = (n, dlat, city) => ({ id: 90000 + n, name: 'T' + n, cat: CATEGORIES[0].id,
        statusCat: CATEGORIES[0].id, lat: base.lat + dlat, lng: base.lng,
        city, prec: 'ROOFTOP', src: 'geocoded', addr: '', phone: '', mail: '', contact: '' });
      const keep = stores;
      stores = [mk2(1, 0, 'Villatest'), mk2(2, 0.001, 'Villatest'),
                mk2(3, 0.002, 'Villatest'), mk2(4, 0.003, 'Villatest'),
                mk2(5, 0.36, 'Villatest'),                       // ~40 km north
                mk2(6, 0, 'No identificada'), mk2(7, 0.36, 'No identificada'),
                mk2(8, 0, 'No identificada'), mk2(9, 0.72, 'No identificada')];
      rebuildTowns(stores);
      const out = {
        spreadTown: TOWNS.has('villatest'),
        junkTown: TOWNS.has('no identificada'),
        flagged: stores.filter(isOffTown).map(s => s.id),
        near: isOffTown(stores[0]), far: isOffTown(stores[4]),
        gap: Math.round(townGap(stores[4])),
        inReview: needsReview(stores[4]),
        // ROOFTOP: Google said it was sure, so no other check would have caught it
        precision: stores[4].prec,
      };
      // a town of three cannot judge anything
      stores = [mk2(1, 0, 'Tresville'), mk2(2, 0.001, 'Tresville'), mk2(3, 0.36, 'Tresville')];
      rebuildTowns(stores);
      out.tooFewToJudge = !isOffTown(stores[2]);
      stores = keep; rebuildTowns(stores);
      return out;
    }""")
    ok("a confident pin far from its own town is flagged",
       town["far"] and town["gap"] > 30, town)
    ok("...even though Google rated it ROOFTOP, so nothing else would catch it",
       town["precision"] == "ROOFTOP" and town["inReview"], town)
    ok("control positive: the stores actually IN the town are not flagged",
       not town["near"] and town["flagged"] == [90005], town)
    # "No identificada" is not a town. Left in, they form one cloud whose centre is
    # nowhere, and then every store in it looks wrong.
    ok("a city column that is not a town is never used as a reference",
       not town["junkTown"] and town["spreadTown"], town)
    ok("a town with too few stores does not get to judge them", town["tooFewToJudge"], town)

    # ---------- the words used for a colour must match the colour ----------
    # STALE_COLOR was changed to pink at some point and the comments, the README and
    # very nearly the customer-facing legend all went on calling it "amber". Nobody
    # notices, because nothing tests prose - and a legend that names a colour the map
    # does not draw sends someone hunting for a ring that is not there.
    colours = page.evaluate("""() => ({ stale: STALE_COLOR, wrong: WRONG_COLOR,
                                        mixed: MIXED_FILL })""")
    named = {"stale": "#ff7ad9", "wrong": "#ff6b6b"}
    for key, want in named.items():
        ok(f"{key} ring is still the colour the docs describe ({want})",
           colours[key].lower() == want, colours)
    # And no state colour may collide with a category colour, or two different things
    # look identical on the map.
    cats = page.evaluate("() => CATEGORIES.map(c => c.color.toLowerCase())")
    clash = [k for k, v in colours.items() if v and v.lower() in cats]
    ok("no state colour collides with a category colour", not clash,
       {"clash": clash, "cats": cats, "state": colours})

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

    # ---------- icon pins on the offline surface ----------
    # Same toggle, same shapes as the Google surface. The thing that can quietly break
    # here is the handle: pins are dragged by looking the store up from data-sid, so a
    # pin drawn without one is a pin nobody can move any more.
    page.uncheck("#clusterBox")
    page.select_option("#reviewMode", "all")
    singles = page.evaluate("visibleStores().length")
    page.check("#iconBox")
    icons = page.evaluate("""() => {
      const g = [...document.querySelectorAll('#offline svg g.pin')];
      return { n: g.length, sid: g.every(e => e.dataset.sid),
               paths: g.length ? g[0].querySelectorAll('path').length : 0 };
    }""")
    ok("icon mode draws one teardrop per visible store", icons["n"] == singles,
       f'{icons["n"]} pins for {singles} stores')
    ok("...each still carrying the id that makes it draggable", icons["sid"] is True)
    ok("...and each is a body plus its category glyph, not a bare shape",
       icons["paths"] == 2, icons["paths"])
    shot("6-icon-pins.png")
    page.uncheck("#iconBox")
    ok("turning it off puts the dots back",
       page.evaluate("document.querySelectorAll('#offline svg g.pin').length") == 0)

    # ---------- colouring by a dedicated store-type column ----------
    # "If we have a dedicated column, can we have automatic differentiated pins?"
    # The failure worth guarding is not the happy path. It is the store whose column
    # is EMPTY: a lookup that returns undefined for it drops the pin off the map with
    # no error anywhere, while the total at the top still looks plausible. So the
    # empty case is asserted first and by name.
    status_ids = page.evaluate("CATEGORIES.map(c => c.id)")
    before = page.evaluate("stores.length")
    page.select_option("#catMode", "stype")
    tally = page.evaluate("""() => {
      const c = {};
      stores.forEach(s => c[s.cat] = (c[s.cat] || 0) + 1);
      return { counts: c, cats: CATEGORIES.map(x => x.id),
               unknown: typeOf('veterinaria').id, empty: typeOf(null).id,
               legend: [...document.querySelectorAll('#legend .count')].map(e => +e.textContent) };
    }""")
    ok("colouring by store type keeps every store on the map",
       page.evaluate("stores.length") == before, f'{before} -> {page.evaluate("stores.length")}')
    ok("...each in exactly one bucket, none counted twice",
       sum(tally["counts"].values()) == before, tally["counts"])
    ok("...and none in a bucket the palette does not contain",
       set(tally["counts"]) <= set(tally["cats"]),
       set(tally["counts"]) - set(tally["cats"]))
    ok("a store whose type column is empty is drawn Unclassified, not dropped",
       tally["counts"].get("unclassified", 0) > 0, tally["counts"])
    ok("...and a value nobody has added to the table yet does the same",
       tally["unknown"] == "unclassified" and tally["empty"] == "unclassified", tally)
    ok("the legend adds up to the whole database, so nothing hides between buckets",
       sum(tally["legend"]) == before, f'legend={sum(tally["legend"])} stores={before}')
    # Control positive on the FIXTURE, not the code. The first version of the demo
    # assignment used a stride that shares a factor with the number of types, so it
    # only ever reached two of the six - every assertion above still passed while the
    # map showed a feature that looked half-built.
    missing = page.evaluate("""(c) => STORE_TYPES.map(t => t.id).filter(id => !c[id])""",
                            tally["counts"])
    ok("...and every store type in the table actually has stores to draw",
       missing == [], missing)
    opts = page.eval_on_selector_all("#nCat option", "e => e.map(x => x.value)")
    ok("the add-store dropdown follows the mode instead of offering statuses",
       "drugstore" in opts and "active" not in opts, opts)
    ok("...and does not offer Unclassified, which is a fallback and not a choice",
       "unclassified" not in opts, opts)
    page.check("#iconBox")
    # A pin Google was unsure about is drawn hollow - the colour comes out of the fill.
    # It then has to go somewhere, and the only place left is the outline. It did not:
    # a dark body with a dark outline, on a dark map, and Unclassified has no glyph to
    # give it away either, so those pins were invisible while the readout said all
    # 2,423 were on the map. Counting them would never have found it; the screenshot did.
    ink = page.evaluate("""() => {
      const DARK = new Set(['#141a21', '#0f1216']);
      const b = [...document.querySelectorAll('#offline svg g.pin')]
        .map(g => g.querySelector('path')).filter(Boolean)
        .map(p => ({ f: p.getAttribute('fill'), s: p.getAttribute('stroke') }));
      return { n: b.length, hollow: b.filter(x => x.f === '#141a21').length,
               invisible: b.filter(x => DARK.has(x.f) && DARK.has(x.s)).length };
    }""")
    ok("control positive: some pins are drawn hollow, so the case is on screen",
       ink["hollow"] > 0, ink)
    ok("...and not one of them is dark on a dark map with nothing to see it by",
       ink["invisible"] == 0, ink)
    shot("7-store-types.png")
    page.uncheck("#iconBox")
    page.select_option("#catMode", "status")
    ok("switching back gives you the status categories exactly as before",
       page.evaluate("CATEGORIES.map(c => c.id)") == status_ids,
       page.evaluate("CATEGORIES.map(c => c.id)"))
    ok("...with every store back on its own status, not stuck on its type",
       page.evaluate("stores.every(s => s.cat === s.statusCat)"))

    # ---------- subcategories folded into their parent ----------
    # "Can we add subcategories later, if we start selling to Baby Stores?" The two
    # modes are two groupings of ONE column, so the only thing that must never change
    # between them is the number of stores on the map.
    page.select_option("#catMode", "stype")
    fine = page.evaluate("""() => {
      const c = {}; stores.forEach(s => c[s.cat] = (c[s.cat] || 0) + 1);
      return { counts: c, total: stores.length, cats: CATEGORIES.map(x => x.id) };
    }""")
    page.select_option("#catMode", "grouped")
    coarse = page.evaluate("""() => {
      const c = {}; stores.forEach(s => c[s.cat] = (c[s.cat] || 0) + 1);
      return { counts: c, total: stores.length, cats: CATEGORIES.map(x => x.id),
               // Where a subcategory store ended up, by name rather than by count -
               // a count alone cannot tell "folded into the parent" from "dropped
               // and replaced by somebody else's store".
               babiesNowSupermarket: stores.filter(s => s.stype === 'babystore')
                                           .every(s => s.cat === 'supermarket'),
               anyBabyBucket: CATEGORIES.some(x => x.id === 'babystore') };
    }""")
    ok("folding subcategories up keeps every store on the map",
       sum(coarse["counts"].values()) == coarse["total"] == sum(fine["counts"].values()),
       f'{sum(coarse["counts"].values())} vs {coarse["total"]}')
    ok("...with Baby store counted as Supermarket, not as a bucket of its own",
       coarse["babiesNowSupermarket"] and not coarse["anyBabyBucket"], coarse["cats"])
    ok("...and the Supermarket bucket grew by exactly the subcategories put into it",
       coarse["counts"].get("supermarket", 0)
       == fine["counts"].get("supermarket", 0) + fine["counts"].get("babystore", 0)
       + fine["counts"].get("petshop", 0),
       f'grouped={coarse["counts"].get("supermarket")} separate={fine["counts"]}')
    ok("control positive: there were subcategory stores to fold in the first place",
       fine["counts"].get("babystore", 0) > 0 and fine["counts"].get("petshop", 0) > 0,
       fine["counts"])

    # ---------- the client's own pin artwork ----------
    page.select_option("#catMode", "stype")
    page.check("#artBox")
    page.wait_for_function("() => ICON_STATE.size > 0")
    art = page.evaluate("""() => {
      const pins = [...document.querySelectorAll('#offline svg g.pin')];
      return {
        state: Object.fromEntries(ICON_STATE),
        withImage: pins.filter(g => g.querySelector('image')).length,
        pins: pins.length,
        // The type whose artwork is deliberately unloadable. Its stores must still be
        // drawn, and drawn with the built-in shape - not skipped, and not blank.
        petPins: stores.filter(s => s.stype === 'petshop').length,
        petDrawnWithGlyph: pinSvg(typeById['petshop']).includes(GLYPH.paw.d),
        petHasNoImage: !pinSvg(typeById['petshop']).includes('<image'),
        goodHasImage: pinSvg(typeById['drugstore']).includes('<image'),
      };
    }""")
    ok("a type can carry your own artwork instead of a built-in shape",
       art["goodHasImage"] and art["withImage"] > 0, art)
    ok("control positive: one of the sample icons is deliberately broken",
       art["state"].get("petshop") == "bad", art["state"])
    ok("...and its stores keep their pins, drawn with the built-in shape",
       art["petPins"] > 0 and art["petDrawnWithGlyph"] and art["petHasNoImage"], art)
    shot("11-custom-artwork.png")
    page.uncheck("#artBox")
    page.wait_for_function("() => [...ICON_STATE.values()].length === 0 || true")
    ok("turning it back off restores the built-in shapes",
       page.evaluate("() => !pinSvg(typeById['drugstore']).includes('<image')"))

    # ---------- artwork that IS the pin (the customer's own marker) ----------
    # Their three files are a WHOLE marker, not a symbol to put inside mine, and the
    # real ones live in pin-art.js which is deliberately not in the repository. So
    # this builds its own, from a 1x1 PNG, and asserts the mechanism rather than the
    # file: a fixture that cannot be missing on a fresh clone.
    art2 = page.evaluate("""() => {
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
                + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const cat = { id:'__art', label:'Art', color:'#001db1',
                    glyph: GLYPH.bag,
                    art: { w:64, h:88, head:{cx:0.5, cy:0.2955, r:0.5}, art: PNG } };
      const before = pinSvg(cat);                 // not verified yet
      ART_STATE.set('__art', 'ok');
      const plain = pinSvg(cat);
      const sel   = pinSvg(cat, { stroke:'#ffffff' });
      const vague = pinSvg(cat, { hollow:true });
      ART_STATE.set('__art', 'bad');
      const broken = pinSvg(cat);
      ART_STATE.delete('__art');
      const cy = s => { const m = s.match(/cy="([\\d.]+)"/); return m ? Number(m[1]) : null; };
      return {
        beforeIsDrawn: before.includes('<path') && !before.includes('<image'),
        plainHasImage: plain.includes('<image'),
        plainHasNoPinPath: !plain.includes(PIN_PATH),
        selRings: (sel.match(/<circle/g) || []).length,
        selHasCasing: sel.includes('#0f1216'),
        selHasWhite: sel.includes('#ffffff'),
        vagueDashed: vague.includes('stroke-dasharray'),
        vagueInCatColour: vague.includes('#001db1'),
        plainNoRing: !plain.includes('<circle'),
        ringCy: cy(sel),
        brokenIsDrawn: broken.includes('<path') && !broken.includes('<image'),
      };
    }""")
    # The whole point of `art`: it REPLACES the built-in teardrop. Drawing it inside
    # the teardrop would put a pin inside a pin, and both assertions below would still
    # pass on the image alone - hence checking the pin path is gone too.
    ok("your artwork replaces the built-in pin instead of sitting inside it",
       art2["plainHasImage"] and art2["plainHasNoPinPath"], art2)
    ok("control positive: before the image has decoded it is the drawn pin, not nothing",
       art2["beforeIsDrawn"], art2)
    # An image cannot be recoloured, so selection and imprecision have to become a
    # ring. If these silently stopped rendering, 570 of 2,423 real pins would lose the
    # only mark that says Google was unsure where they are.
    ok("a selected artwork pin still gets a ring, drawn over a dark casing",
       art2["selRings"] == 2 and art2["selHasCasing"] and art2["selHasWhite"], art2)
    ok("...and an imprecise one gets a broken ring in its own colour",
       art2["vagueDashed"] and art2["vagueInCatColour"], art2)
    ok("control positive: a plain artwork pin draws no ring at all",
       art2["plainNoRing"], art2)
    # Measured from the artwork, so it lands on the round head. A constant would put
    # it across the point the day the artwork changes proportions.
    ok("the ring lands on the head of the pin, not across its point",
       art2["ringCy"] is not None and 3 < art2["ringCy"] < 14, art2["ringCy"])
    ok("artwork that fails to decode falls back to the drawn pin, never to nothing",
       art2["brokenIsDrawn"], art2)

    # ---------- what the polygon hands back ----------
    page.select_option("#catMode", "status")
    page.uncheck("#iconBox")
    contact = page.evaluate("""() => {
      const s = stores[0];
      selectedIds = new Set([s.id]);
      renderSelection();
      const html = document.getElementById('selList').innerHTML;
      return { phone: s.phone, mail: s.mail,
               hasPhone: html.includes(s.phone),
               hasAddr: html.includes(s.addr),
               shownForMissing: html.includes('no e-mail on record')
                                || html.includes(s.mail) };
    }""")
    ok("selecting a store hands back its phone and address, not just its name",
       contact["hasPhone"] and contact["hasAddr"], contact)
    # A blank column and a broken page look identical in a list. On the real export
    # 1,253 of 2,423 pinned rows have no e-mail at all, so this is the common case,
    # not the edge one.
    ok("...and says so out loud when a contact field is empty in the CRM",
       contact["shownForMissing"], contact)

    # ---------- the CSV your team opens in Excel ----------
    # Three hazards, all of them present in the real export, all fed in at once.
    csv = page.evaluate("""() => {
      const s = { id: 4268, name: 'Wheelchairs "Emiro"', cat: 'active',
                  phone: '+573174371165', contact: 'Maria Juliana, Yosely',
                  mail: '', addr: 'CR 70 C 55 33, Cali', city: 'Cali',
                  lat: 3.44, lng: -76.48, prec: 'ROOFTOP' };
      const text = csvOf([s]);
      const body = text.split('\\r\\n')[1];
      // Count fields the way a CSV reader does, so an unescaped quote or comma shows
      // up as the wrong number of columns rather than as text that merely looks odd.
      let n = 1, q = false;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '"') { if (q && body[i + 1] === '"') i++; else q = !q; }
        else if (c === ',' && !q) n++;
      }
      return { header: text.split('\\r\\n')[0].replace(/^\\uFEFF/, ''),
               bom: text.charCodeAt(0) === 0xFEFF,
               fields: n,
               cols: text.split('\\r\\n')[0].replace(/^\\uFEFF/, '').split(',').length,
               phoneCell: body.split('","')[3],
               keepsQuotes: body.includes('Wheelchairs ""Emiro""') };
    }""")
    ok("the CSV carries phone, contact, e-mail and address as columns",
       all(c in csv["header"] for c in ("phone", "contact", "email", "address")),
       csv["header"])
    ok("a name with quotes in it does not shift every later column",
       csv["fields"] == csv["cols"] and csv["keepsQuotes"], csv)
    # 241 of the real phone numbers start with '+', which Excel reads as a formula and
    # renders as #NAME?. The row is intact either way, so only looking at the cell
    # catches this.
    ok("a phone number starting with + is not handed to Excel as a formula",
       csv["phoneCell"].startswith("'+57"), csv["phoneCell"])
    ok("...and the file starts with a BOM so accents survive Excel on Windows",
       csv["bom"], csv)

    ok("no uncaught javascript errors on the page", not errors, errors)
    browser.close()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
