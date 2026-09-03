"""Renders the pin legend FROM THE LIVE PAGE, so it cannot drift from the code.
Every swatch is real pinSvg() output, not a drawing of what I think it does."""
from playwright.sync_api import sync_playwright
import pathlib
D = pathlib.Path('/var/lib/freelancer/projects/40677527/demo')

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':1100,'height':1180})
    pg.goto((D/'store-map-demo.html').as_uri())
    pg.wait_for_selector('#offline svg', timeout=20000)
    pg.wait_for_timeout(2500)

    html = pg.evaluate("""() => {
      const cat = id => STATUS_CATEGORIES.find(c => c.id === id);
      const sv = (c, o, extra='') =>
        `<svg width="46" height="46" viewBox="0 0 24 24">${extra}${pinSvg(c, o)}</svg>`;
      const A = cat('active'), P = cat('potential'), I = cat('inactive');
      const ring = (col, w) => `<circle cx="12" cy="9.4" r="11" fill="none" stroke="${col}" stroke-width="${w}"/>`;

      const rows = [
        ['STATUS &mdash; which pin, from your three files', null, null, null],
        [sv(A), 'Active store', 'You sell to them today.', '1,132'],
        [sv(P), 'Potential', 'A prospect. Not a customer yet.', '1,253'],
        [sv(I), 'Inactive store', 'Was a customer, is not now.', '38'],

        ['HOW SURE GOOGLE WAS about the address', null, null, null],
        [sv(P), 'Solid edge &mdash; exact',
         'Google found the building itself. The pin is on the door.', '1,853'],
        [sv(P, {hollow:true}), 'Broken ring &mdash; approximate',
         'Google could not find that exact address and fell back to the middle of the '
         + 'town or the street. The pin is in the right area, not on the right building. '
         + 'This is your check-these list.', '570'],

        ['WHAT THE MAP IS TELLING YOU RIGHT NOW', null, null, null],
        [sv(P, {stroke:'#ffffff', weight:2.2}), 'White ring &mdash; selected',
         'This store is inside the polygon you have drawn.', '&mdash;'],
        [sv(P, {}, ring(STALE_COLOR, 2)), 'Pink ring &mdash; address changed',
         'Somebody edited the address after the pin was placed, so the pin is on the '
         + 'old street until it is re-geocoded.', '0 today'],
        [sv(P, {}, ring(WRONG_COLOR, 2.4)), 'Red ring &mdash; wrong country',
         'The coordinates are outside Colombia. Not imprecise &mdash; wrong.', '3'],
        ['<svg width="46" height="46" viewBox="0 0 24 24">' + pinSvg(P) +
         '<circle cx="12" cy="9.4" r="2" fill="#0f1216"/></svg>', 'Dark centre dot &mdash; moved by hand',
         'You dragged this pin yourself. A re-geocode will never move it back.', '0 so far'],

        ['GROUPED PINS', null, null, null],
        ['<svg width="46" height="46"><circle cx="23" cy="23" r="15" fill="#2a3038" '
         + 'stroke="#0f1216" stroke-width="1.5"/><text x="23" y="27" text-anchor="middle" '
         + 'fill="#e6ebf1" font-size="12" font-weight="700">21</text></svg>',
         'Numbered bubble', 'Several stores too close together to draw separately. The '
         + 'ring around it shows the mix of statuses inside. Untick <b>Group nearby '
         + 'pins</b> on the map, or click it to zoom in.', '&mdash;'],
      ];
      return rows.map(r => r[1] === null
        ? `<tr class="h"><td colspan="4">${r[0]}</td></tr>`
        : `<tr><td class="sw">${r[0]}</td><td class="nm">${r[1]}</td>`
          + `<td class="ds">${r[2]}</td><td class="ct">${r[3]}</td></tr>`).join('');
    }""")

    pg.set_content(f"""<body>
      <h1>Your map, pin by pin</h1>
      <p class="sub">Pins and rings are produced by the map's own code and colours,
         not redrawn by hand. Counts are your 2,423 pinned stores, 1-Sep geocoding run.</p>
      <table>{html}</table>
      <style>
        body{{margin:0;padding:20px 26px;background:#12161b;color:#e6ebf1;
             font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}}
        h1{{margin:0 0 4px;font-size:20px}}
        .sub{{margin:0 0 16px;color:#8b97a6;font-size:12.5px}}
        table{{border-collapse:collapse;width:100%}}
        td{{padding:9px 10px;border-bottom:1px solid #232a32;vertical-align:middle}}
        tr.h td{{background:#1a2027;color:#8b97a6;font-size:11px;letter-spacing:.09em;
                 font-weight:700;padding:8px 10px;border-bottom:1px solid #2a323b}}
        .sw{{width:56px;text-align:center}}
        .nm{{width:230px;font-weight:600}}
        .ds{{color:#aab4c0;font-size:13px}}
        .ct{{width:74px;text-align:right;color:#e6ebf1;font-variant-numeric:tabular-nums;
             font-weight:700}}
      </style></body>""")
    pg.wait_for_timeout(800)
    h = pg.evaluate("() => document.querySelector('table').getBoundingClientRect().bottom")
    h = int(h) + 22
    print("trimmed height", h)
    pg.set_viewport_size({'width':1100,'height':min(h, 1900)})
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(D/'real-shots'/'31-pin-legend.png'))
    b.close()
