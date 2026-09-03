'use strict';
/* The accept/reject rule for the second geocoding pass. No database, no network.
 *
 * The rule matters more than the geocoding: a second opinion that is merely more
 * CONFIDENT is not a reason to move a customer's pin. Google grading its own answer
 * is exactly the signal that failed on Hot Fill - ROOFTOP, in the wrong city.
 */
const { decide, buildTowns, kmApart, townKey, RANK, NOT_A_TOWN } =
  require('./regeocode-with-name');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : '')); }
};

/* A town of four stores within a few hundred metres, so its bar is the 8 km floor. */
const rows = [
  { lat: 6.15, lng: -75.38, city: 'Rionegro' },
  { lat: 6.151, lng: -75.381, city: 'Rionegro' },
  { lat: 6.152, lng: -75.379, city: 'Rionegro' },
  { lat: 6.149, lng: -75.382, city: 'Rionegro' },
  { lat: 6.15, lng: -75.38, city: 'No identificada' },
  { lat: 9.99, lng: -70.00, city: 'No identificada' },
  { lat: 6.15, lng: -75.38, city: 'No identificada' },
  { lat: 1.00, lng: -70.00, city: 'No identificada' },
];
const towns = buildTowns(rows);
const rio = towns.get('rionegro');

ok('a town of four anchors a reference point', Boolean(rio), [...towns.keys()]);
// Left in, these form one cloud whose centre is nowhere, and then every store in it
// looks wrong - including the ones that are perfectly placed.
ok('a city column that is not a city is never a reference',
   !towns.has('no identificada'), [...towns.keys()]);
ok('a tight town still gets the 8 km floor, not a 200 m hair trigger',
   rio.far === 8, rio);

const before = { lat: 6.15, lng: -75.38, precision: 'APPROXIMATE' };

ok('a more precise answer nearby is taken',
   decide({ before, after: { lat: 6.153, lng: -75.383, precision: 'ROOFTOP' }, town: rio }).take);

// The Hot Fill failure, as a rule: Google was MORE sure and 23 km out of town.
const far = decide({ before, after: { lat: 6.35, lng: -75.56, precision: 'ROOFTOP' }, town: rio });
ok('a more precise answer OUTSIDE the town is refused', !far.take, far);
ok('...and says how far outside, rather than just "rejected"',
   /\d/.test(far.why), far);

const worse = decide({ before, after: { lat: 6.151, lng: -75.381, precision: 'APPROXIMATE' }, town: rio });
ok('an answer no better than the one we have does not move the pin', !worse.take, worse);

ok('a downgrade is refused',
   !decide({ before: { ...before, precision: 'ROOFTOP' },
             after: { lat: 6.151, lng: -75.381, precision: 'APPROXIMATE' }, town: rio }).take);

ok('no answer at all leaves the pin alone',
   !decide({ before, after: null, town: rio }).take);

/* Control positive: without the town check, the Hot Fill answer WOULD be taken.
   Proves the town rule is what rejects it, not the precision comparison. */
const noTown = decide({ before, after: { lat: 6.35, lng: -75.56, precision: 'ROOFTOP' }, town: null });
ok('control positive: it is the TOWN rule that catches it, not the precision',
   noTown.take, noTown);

// A store in a town we have no reference for still gets the precision guard, and is
// not silently blocked either - unknown town must not mean "never improve".
ok('a store in an unknown town can still be improved',
   decide({ before, after: { lat: 6.16, lng: -75.39, precision: 'ROOFTOP' }, town: null }).take);

ok('distance maths is sane (Rionegro to Medellin is about 23 km)',
   Math.abs(kmApart({ lat: 6.15, lng: -75.38 }, { lat: 6.2387, lng: -75.5648 }) - 23) < 3,
   kmApart({ lat: 6.15, lng: -75.38 }, { lat: 6.2387, lng: -75.5648 }));

ok('town names normalise past accents and codes',
   townKey('Medellín') === 'medellin' && townKey('41-001 - Neiva') === 'neiva'
   && townKey('Bogota D.C.') === 'bogota',
   [townKey('Medellín'), townKey('41-001 - Neiva'), townKey('Bogota D.C.')]);

ok('ROOFTOP outranks every other grade',
   RANK.ROOFTOP > RANK.RANGE_INTERPOLATED && RANK.RANGE_INTERPOLATED > RANK.GEOMETRIC_CENTER
   && RANK.GEOMETRIC_CENTER > RANK.APPROXIMATE);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
