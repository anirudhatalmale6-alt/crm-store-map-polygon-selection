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
# ?demo=1 pins the page to the 24 built-in stores. Without it, an exported
# map-data.js sitting next to the file would silently replace the data set these
# assertions describe.
HTML = "file://" + os.path.join(HERE, "store-map-demo.html") + "?demo=1"

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
  /* Bounds are REAL here, not a fixed pair of corners.
     They used to be hard-coded to a Madrid rectangle, which quietly made this stub
     unable to express the one thing bounds are for: that the view moves. Code that
     asks "is this store on screen?" would have got the same answer at every zoom,
     so a viewport bug could not fail this suite. */
  class LatLngBounds {
    constructor(sw, ne) {
      const c = p => p && { lat: typeof p.lat === 'function' ? p.lat() : p.lat,
                            lng: typeof p.lng === 'function' ? p.lng() : p.lng };
      this.sw = c(sw); this.ne = c(ne);
    }
    extend(p) {
      const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
      const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
      if (!this.sw) { this.sw = { lat, lng }; this.ne = { lat, lng }; return this; }
      this.sw = { lat: Math.min(this.sw.lat, lat), lng: Math.min(this.sw.lng, lng) };
      this.ne = { lat: Math.max(this.ne.lat, lat), lng: Math.max(this.ne.lng, lng) };
      return this;
    }
    getSouthWest() { return new LatLng(this.sw.lat, this.sw.lng); }
    getNorthEast() { return new LatLng(this.ne.lat, this.ne.lng); }
  }
  class Map_ {
    constructor(el, opts) { this.el = el; this.opts = opts || {}; this._b = null; window.__stub.map = this; }
    setOptions(o) { Object.assign(this.opts, o); window.__stub.cursor = this.opts.draggableCursor || null; }
    getBounds() { return this._b; }
    fitBounds(b) { this._b = b; window.__stub.fitted = b; }
    getCenter() {
      const b = this._b;
      return b ? new LatLng((b.sw.lat + b.ne.lat) / 2, (b.sw.lng + b.ne.lng) / 2) : new LatLng(0, 0);
    }
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
    Map: Map_, Marker, Polyline, Polygon, LatLng, LatLngBounds,
    Size: function (w, h) { this.width = w; this.height = h; },
    Point: function (x, y) { this.x = x; this.y = y; },
    SymbolPath: { CIRCLE: 0 },
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

    # ---------- a mixed bubble must not wear another category's colour ----------
    # The reported bug: with only Active ticked the pins looked right; ticking
    # Potential turned bubbles the colour of Inactive. Cause: a cluster holding more
    # than one category was painted #8b97a6, which IS the Inactive colour, byte for
    # byte. The demo palette has no grey category, so demo data could never show it -
    # this assertion is written against the palettes themselves for that reason.
    clash = page.evaluate("""() => {
      const all = [...REAL_CATEGORIES, ...DEMO_CATEGORIES];
      return all.filter(c => c.color.toLowerCase() === MIXED_FILL.toLowerCase()).map(c => c.id);
    }""")
    ok("the mixed-cluster fill belongs to no category, in either palette", clash == [], clash)

    # And the mix has to survive being drawn, not just be a different flat colour.
    arcs = page.evaluate("""() => {
      const mix = clusterMix([{cat:'active'},{cat:'active'},{cat:'potential'}], CATEGORIES);
      const svg = mixRing(20, 20, 12, mix, 5);
      return { n: mix.length, counts: mix.map(m => m.count),
               strokes: (svg.match(/stroke="#[0-9a-f]{6}"/gi) || []).length,
               colours: mix.map(m => svg.includes('stroke="' + m.color + '"')) };
    }""")
    ok("a 2-active + 1-potential cluster reports both categories with their counts",
       arcs["n"] == 2 and arcs["counts"] == [2, 1], arcs)
    ok("...and draws one arc per category, each in that category's own colour",
       arcs["strokes"] == 2 and all(arcs["colours"]), arcs)

    # ---------- only what is on screen becomes a marker ----------
    # Measured on the client's 2,423 stores at city zoom: 424 markers existed and
    # every one of them took five setter calls on every redraw - 2,120 SDK mutations
    # per mouse move while dragging a polygon corner. That is the "very slow to draw
    # polygons" report. Both halves are fixed here: clip to the viewport, and leave a
    # marker alone when nothing about it changed.
    page.evaluate("""() => {
      stores = stores.concat([{id: 90001, name: 'Far away', cat: 'active',
                               lat: -33.45, lng: -70.66, src: 'geocoded', prec: 'ROOFTOP',
                               addr: 'Santiago', locAddr: 'Santiago'}]);
      recompute();
    }""")
    far = page.evaluate("""() => window.__stub.markers.filter(m => !m._gone)
        .some(m => Math.abs(m.position.lat + 33.45) < 0.01)""")
    ok("a store on another continent gets no marker while you are looking at Madrid",
       far is False)
    ok("...but it is still counted as visible, so nothing has been hidden from you",
       page.evaluate("visibleStores().some(s => s.id === 90001)") is True)

    # The invariant clipping must not break: what a polygon selects cannot depend on
    # where the map happens to be pointing, or panning would silently edit the answer.
    page.click("#drawBtn")
    for c in corners:
        page.evaluate(click_map, c)
    page.click("#drawBtn")
    sel_before = page.text_content("#selCount")
    ok("control positive: the polygon selected something to begin with",
       int(sel_before) > 0, sel_before)
    page.evaluate("""() => { window.__stub.map.fitBounds(
        new google.maps.LatLngBounds({lat: -34, lng: -71}, {lat: -33, lng: -70})); recompute(); }""")
    ok("panning to the other side of the world does not change the selection",
       page.text_content("#selCount") == sel_before,
       f"{sel_before} -> {page.text_content('#selCount')}")

    # ---------- an unchanged marker is not touched ----------
    # Back to Madrid, where the markers are, and let them settle before counting.
    page.evaluate("""() => { window.__stub.map.fitBounds(
        new google.maps.LatLngBounds({lat: 40.37, lng: -3.78}, {lat: 40.47, lng: -3.62}));
        recompute(); }""")
    page.evaluate("""() => {
      window.__calls = 0;
      const M = window.google.maps.Marker;
      for (const k of ['setIcon','setLabel','setTitle','setPosition','setDraggable']) {
        const o = M.prototype[k];
        M.prototype[k] = function (v) { window.__calls++; return o.call(this, v); };
      }
    }""")
    live_now = page.evaluate("window.__stub.markers.filter(m => !m._gone).length")
    ok("control positive: there are markers on the map to leave alone", live_now > 0, live_now)
    page.evaluate("recompute()")
    ok("a redraw that changes nothing pushes nothing into the SDK",
       page.evaluate("window.__calls") == 0, page.evaluate("window.__calls"))
    # 0 is also what a render() that never ran looks like, so prove the counter can
    # move. Clearing the polygon changes how the selected markers are drawn while
    # leaving their cluster keys - and therefore the marker objects - exactly as they
    # were, which is precisely the path the diff is allowed to skip and must not.
    page.evaluate("() => { window.__calls = 0; }")
    page.click("#clearBtn")
    ok("control positive: a redraw that DOES change something still repaints",
       page.evaluate("window.__calls") > 0, page.evaluate("window.__calls"))

    # ---------- a half-initialised map must not look like a working one ----------
    # Google builds the basemap first and everything we add to it second, so a throw
    # in the second half leaves the tiles on screen with the features behind them
    # dead. The client photographed exactly that: a live Google basemap with the
    # badge and banner still reading "offline preview". Nothing failed loudly.
    page2 = browser.new_page(viewport={"width": 1280, "height": 720})
    page2.goto(HTML)
    page2.wait_for_selector("#offline svg circle")
    page2.evaluate(STUB)
    # Marker stands in for ANY class retired after the map itself is constructed.
    # Overriding it after the stub is built keeps this independent of the stub's
    # internals - the point is the throw, not which class does the throwing.
    # Wrapped in a statement body on purpose: an expression whose VALUE is a
    # function gets called by page.evaluate rather than merely assigned.
    page2.evaluate("() => { window.google.maps.Marker = function () "
                   "{ throw new TypeError('google.maps.Marker is not a constructor'); }; }")
    page2.evaluate("window.__gmapReady()")

    tag2 = page2.text_content("#modeTag").strip()
    ok("a failed init does not leave the badge claiming offline preview",
       tag2 != "offline preview", tag2)
    ok("...it says the Google surface failed", "fail" in tag2.lower(), tag2)
    ok("...and the banner carries Google's own error text, not a generic message",
       "Marker is not a constructor" in page2.text_content("#banner"),
       page2.text_content("#banner")[:90])
    ok("...and the user is put back on the surface that fully works",
       page2.eval_on_selector("#offline", "e => getComputedStyle(e).display") == "block"
       and page2.eval_on_selector("#gmap", "e => getComputedStyle(e).display") == "none")
    # Control positive: this all has to be reachable, i.e. the stub really did break
    # init. If Marker had quietly worked, the four assertions above would be judging
    # a successful load and the "offline preview" one would pass for free.
    ok("control positive: the injected failure actually fired",
       page2.evaluate("window.__stub.markers.length") == 0,
       page2.evaluate("window.__stub.markers.length"))
    ok("...and selection still works on the surface it fell back to",
       page2.evaluate("document.querySelectorAll('#offline svg circle').length") > 0)

    browser.close()

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
