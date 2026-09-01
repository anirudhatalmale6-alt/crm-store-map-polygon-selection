"""The Google Maps surface, tested without a Google Maps key.

Why this file exists
--------------------
The map had a dead feature in it and every test passed. `GoogleSurface.init()`
called `new google.maps.drawing.DrawingManager(...)`, which Google REMOVED in Maps
JavaScript API v3.65. Removal is not a console warning — the constructor throws, and
the throw aborted the rest of init(). The basemap still appeared, so it looked fine.
What died silently was everything below that line: the `idle` listener that
re-clusters on zoom, and polygon drawing itself, which is the whole product.

Nothing caught it because every browser test drives the OFFLINE surface. The Google
surface needs a key, a key costs money and cannot go in a repo, so it was never
exercised — and "we can't test it" quietly became "it doesn't work".

The fix is a stub. `google.maps` is just an object; the demo uses a small, known part
of it. Implementing that part in ~60 lines gets the real init(), the real render()
and the real drawing code running in a real browser, with no key, no network and no
bill.

The load-bearing property of the stub
-------------------------------------
It implements ONLY what Google currently documents. It has no `google.maps.drawing`,
because Google no longer has one. So the day this code reaches for a retired API
again, this suite fails — which is the failure that actually happened, caught the
way it should have been. A stub that mirrored whatever the page happened to call
would have passed against DrawingManager too, and been worth nothing.

What it does NOT test: that Google's tiles render, that a key is valid, or that
referrer restrictions are right. Those need a real key and a real browser on the real
domain — they are checked by hand, and the check is in the README.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = "file://" + os.path.join(HERE, "store-map-demo.html")

PASS = FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print("  ok   " + name)
    else:
        FAIL += 1; print("  FAIL " + name + (("  ->  " + str(extra)) if extra else ""))

# A deliberately minimal google.maps. Every class here is one Google still ships.
STUB = r"""
window.__stub = { markers: [], polylines: [], polygons: [], listeners: {}, cursor: null };
(function () {
  const rec = (bag, o) => { bag.push(o); return o; };
  function LatLng(lat, lng) { this._lat = lat; this._lng = lng; }
  LatLng.prototype.lat = function () { return this._lat; };
  LatLng.prototype.lng = function () { return this._lng; };

  class MVCArray {
    constructor(a) { this.a = (a || []).map(p => new LatLng(p.lat, p.lng)); }
    getArray() { return this.a; }
  }
  class Map_ {
    constructor(el, opts) { this.el = el; this.opts = opts || {}; this._h = {}; window.__stub.map = this; }
    setOptions(o) { Object.assign(this.opts, o); window.__stub.cursor = this.opts.draggableCursor || null; }
    getCenter() { return new LatLng(40.42, -3.702); }
    getBounds() {
      return { getNorthEast: () => new LatLng(40.47, -3.65), getSouthWest: () => new LatLng(40.37, -3.75) };
    }
    fitBounds() {}
  }
  class Marker {
    constructor(o) { Object.assign(this, o); rec(window.__stub.markers, this); }
    setPosition(p) { this.position = p; } setIcon(i) { this.icon = i; }
    setLabel(l) { this.label = l; } setTitle(t) { this.title = t; }
    setDraggable(d) { this.draggable = d; } setMap(m) { this.map = m; if (!m) this._gone = true; }
    addListener() {}
  }
  class Polyline {
    constructor(o) { Object.assign(this, o); this._path = new MVCArray(o.path); rec(window.__stub.polylines, this); }
    getPath() { return this._path; }
    setMap(m) { this.map = m; if (!m) this._gone = true; }
  }
  class Polygon {
    constructor(o) { Object.assign(this, o); this._path = new MVCArray(o.paths); rec(window.__stub.polygons, this); }
    getPath() { return this._path; }
    setMap(m) { this.map = m; if (!m) this._gone = true; }
  }
  window.google = { maps: {
    Map: Map_, Marker, Polyline, Polygon, LatLng, Size: function () {}, Point: function () {},
    SymbolPath: { CIRCLE: 0 },
    LatLngBounds: function () { this.extend = function () {}; },
    event: {
      addListener(obj, ev, fn) { (window.__stub.listeners[ev] = window.__stub.listeners[ev] || []).push({ obj, fn }); },
    },
  } };
  // Note the absence of google.maps.drawing. That is the point of this file.
})();
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(HTML)
    page.wait_for_selector("#offline svg circle")
    page.uncheck("#clusterBox")

    page.evaluate(STUB)
    page.evaluate("window.__gmapReady()")

    # ---------- init survived ----------
    ok("init() runs to completion against the current Google API", not errors, errors)
    ok("the mode badge says Google Maps, not offline preview",
       page.text_content("#modeTag").strip() == "Google Maps", page.text_content("#modeTag"))
    ok("the banner stops advertising the offline preview",
       "Offline preview" not in page.text_content("#banner"), page.text_content("#banner"))
    ok("the offline surface is hidden once Google is live",
       page.eval_on_selector("#offline", "e => getComputedStyle(e).display") == "none")

    # Control positive: the three assertions above would all pass on a page that
    # never got as far as creating a single marker.
    made = page.evaluate("window.__stub.markers.length")
    ok("control positive: markers were actually created on the Google surface", made == 24, made)

    # ---------- the listener that died with the DrawingManager throw ----------
    listeners = page.evaluate("Object.keys(window.__stub.listeners)")
    ok("a map 'idle' listener is registered, so clusters update on zoom",
       "idle" in listeners, listeners)
    ok("a map 'click' listener is registered, so polygon corners can be placed",
       "click" in listeners, listeners)

    # ---------- drawing, end to end, through the real code ----------
    page.click("#drawBtn")
    ok("arming the tool switches the map cursor to a crosshair",
       page.evaluate("window.__stub.cursor") == "crosshair", page.evaluate("window.__stub.cursor"))

    click_map = """(pt) => {
      const l = window.__stub.listeners.click.find(x => x.obj === window.__stub.map);
      l.fn({ latLng: new google.maps.LatLng(pt.lat, pt.lng) });
    }"""
    corners = [{"lat": 40.44, "lng": -3.73}, {"lat": 40.44, "lng": -3.68},
               {"lat": 40.40, "lng": -3.68}, {"lat": 40.40, "lng": -3.73}]
    for c in corners:
        page.evaluate(click_map, c)

    live_lines = page.evaluate("window.__stub.polylines.filter(p => !p._gone).length")
    ok("while drawing, the shape is an open polyline, not a closed polygon",
       live_lines == 1 and page.evaluate("window.__stub.polygons.filter(p => !p._gone).length") == 0,
       f"lines={live_lines}")

    page.click("#drawBtn")          # Finish polygon
    live_polys = page.evaluate("window.__stub.polygons.filter(p => !p._gone).length")
    ok("finishing turns it into one closed polygon", live_polys == 1, live_polys)
    ok("the finished polygon is editable, so corners can be dragged",
       page.evaluate("window.__stub.polygons.filter(p => !p._gone)[0].editable") is True)
    ok("the cursor goes back to normal after finishing",
       page.evaluate("window.__stub.cursor") is None)

    sel = int(page.text_content("#selCount"))
    ok("drawing on the Google surface selects stores (control positive)", sel > 0, sel)
    ok("...and not all of them, which would mean the polygon was ignored", sel < 24, sel)

    # ---------- the bug the idempotence guard prevents ----------
    # Re-rendering must not destroy and rebuild the overlay the user may be holding.
    before = page.evaluate("window.__stub.polygons.length")
    page.evaluate("window.__stub.listeners.idle.forEach(l => l.fn())")
    page.evaluate("window.__stub.listeners.idle.forEach(l => l.fn())")
    after = page.evaluate("window.__stub.polygons.length")
    ok("re-rendering does not rebuild an unchanged polygon", after == before,
       f"{before} -> {after}")
    ok("...and the polygon is still on the map afterwards",
       page.evaluate("window.__stub.polygons.filter(p => !p._gone).length") == 1)
    ok("the selection is unchanged by a re-render", int(page.text_content("#selCount")) == sel)

    page.click("#clearBtn")
    ok("clear removes the polygon from the Google surface",
       page.evaluate("window.__stub.polygons.filter(p => !p._gone).length") == 0)
    ok("clear resets the selection", page.text_content("#selCount") == "0")

    ok("no uncaught javascript errors during the whole run", not errors, errors)
    browser.close()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
