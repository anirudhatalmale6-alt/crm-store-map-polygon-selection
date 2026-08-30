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
    page.goto(HTML)
    page.wait_for_selector("#offline svg circle")
    shot = lambda n: page.screenshot(path=os.path.join(SHOTS, n))

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
    page.uncheck('#legend input[data-cat="franchise"]')
    filtered = sorted(e.text_content() for e in page.query_selector_all("#selList .store b"))
    cats = {s["name"]: s["cat"] for s in all_stores}
    want = sorted(n for n in expected if cats[n] != "franchise")
    ok("hiding a category drops those stores from the selection", filtered == want,
       f"ui={filtered} want={want}")
    ok("hiding a category actually changed something (control positive)", want != expected,
       "the polygon contained no franchise stores - test is vacuous")
    shot("4-category-filtered.png")
    page.check('#legend input[data-cat="franchise"]')

    # ---------- clear ----------
    page.click("#clearBtn")
    ok("clear resets the selection", page.text_content("#selCount") == "0")
    ok("clear removes the polygon from the map",
       len(page.query_selector_all("#offline svg polygon")) == 0)

    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    browser.close()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
