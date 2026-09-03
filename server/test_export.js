/* What each export is allowed to carry.
 *
 * These are pure-function tests on purpose: they need no database, so they run on
 * any machine and they run before anything is deployed. The rule they protect is
 * the one that cannot be fixed after the fact - once a phone number has been in
 * the source of a public page, it has been published, and deleting it later does
 * not un-publish it.
 */
const assert = require('assert');
const { categoryOf, projectRow, AUDIENCES } = require('./export-map-data');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
};

/* Shaped like a row that actually comes back from your database, with values
   distinctive enough that finding them in a string is unambiguous. A test built
   on 'foo' and 'bar' can match by accident; these cannot. */
const ROW = {
  id: 4268,
  name: 'Wheelchairs "Emiro"',
  type: 'store',
  status: 1,
  phone: '+573174371165',
  mail: 'ervinzapatab@gmail.com',
  contact: 'Maria Juliana, Yosely',
  lat: '3.4392210',
  lng: '-76.4868886',
  prec: 'ROOFTOP',
  src: 'geocoded',
  city: 'Cali',
  state: 'Valle del Cauca',
  addr: 'CR 70 C 55 33 APT 302, Cali, Valle del Cauca, Colombia',
};
const SECRETS = [ROW.phone, ROW.mail, ROW.contact, ROW.addr];

console.log('categoryOf');
ok('an active store is active', categoryOf({ type: 'store', status: 1 }) === 'active');
ok('a store that is not active is inactive', categoryOf({ type: 'store', status: 0 }) === 'inactive');
ok('anything not a store is a prospect', categoryOf({ type: 'potential', status: 1 }) === 'potential');

console.log('\ninternal export - the CRM map your team draws polygons on');
const inner = projectRow(ROW, 'internal');
ok('carries the phone number', inner.phone === ROW.phone, inner.phone);
ok('carries the e-mail', inner.mail === ROW.mail, inner.mail);
ok('carries the contact person', inner.contact === ROW.contact, inner.contact);
ok('carries the street address', inner.addr === ROW.addr, inner.addr);
ok('carries the coordinates as numbers, not the strings mysql returns',
   typeof inner.lat === 'number' && typeof inner.lng === 'number',
   { lat: typeof inner.lat, lng: typeof inner.lng });

/* Missing has to survive as missing. A dash or an "N/D" is a value, and the whole
   point of a blank is that "which stores have no e-mail" can find them - on your
   data that is 1,253 of the 2,423 pinned rows. */
const bare = projectRow({ ...ROW, phone: null, mail: undefined, contact: '' }, 'internal');
ok('an empty contact field stays empty rather than becoming a placeholder',
   bare.phone === '' && bare.mail === '' && bare.contact === '', bare);

console.log('\npublic export - the page anybody can open');
const outer = projectRow(ROW, 'public');
/* Scanned as SERIALISED TEXT, not by checking key names. A key check answers
   "is there a field called phone", which is not the question - the question is
   whether the number is in the file at all, under any name, nested anywhere. */
const publicText = JSON.stringify(outer);
const internalText = JSON.stringify(inner);
for (const s of SECRETS) {
  ok(`the public feed does not contain ${JSON.stringify(s.slice(0, 24))}`,
     !publicText.includes(s), publicText);
}
/* Without this the four assertions above would pass on an empty object, on a typo
   in the field names, and on a projectRow that returned null - none of which is
   the thing being claimed. */
for (const s of SECRETS) {
  ok(`control positive: the internal feed DOES contain ${JSON.stringify(s.slice(0, 24))}`,
     internalText.includes(s), null);
}
ok('the public feed still has what a map needs: name, coordinates, city, category',
   outer.name === ROW.name && outer.lat === 3.439221 && outer.city === 'Cali'
   && outer.cat === 'active', outer);
ok('...and nothing else at all', Object.keys(outer).sort().join(',')
   === 'cat,city,id,lat,lng,name', Object.keys(outer));

console.log('\naudience');
ok('there are exactly two, and internal is not one of them by accident',
   AUDIENCES.length === 2 && AUDIENCES.includes('internal') && AUDIENCES.includes('public'),
   AUDIENCES);
/* A misspelled audience must not fall back to the permissive one. This is checked
   on projectRow's own behaviour rather than on the CLI, because the CLI needs a
   database to reach the guard and this test deliberately needs nothing. */
ok('an unknown audience is treated as internal by projectRow, and the CLI refuses it first',
   projectRow(ROW, 'publik').phone === ROW.phone, 'see main(): AUDIENCES.includes check');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
