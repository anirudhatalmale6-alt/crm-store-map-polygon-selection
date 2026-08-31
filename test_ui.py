"""Drives the demo in a real browser: draws a polygon, checks the selected list
against an independently-computed expectation, then exercises the three CRM sync
cases (add / remove / move). Screenshots each step."""
import json, os, re, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = "file://" + os.path.join(HERE, "store-map-demo.html")
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
