// Spec 0029 (child 0003): a local stand in for BMS's Flow C routes, until BMS builds them.
// It answers on welinc-network as `bms-gateway:3020`, the name the suite gateway sends /bms/ to,
// so VRMS's real calls go through the real gateway and only BMS is faked. It checks no token.
//
// Run it (the BMS stack must be stopped, it uses the same name):
//   docker run --rm --name vrms-bms-stub --network welinc-network --network-alias bms-gateway \
//     -v "$PWD/scripts:/stub:ro" node:24-alpine node /stub/bms-stub.mjs
// BMS_STUB_DOWN=1 answers 503 everywhere, to see "BMS can't be reached" and the retries.

import { createServer } from 'node:http';

const PORT = 3020;
const down = process.env.BMS_STUB_DOWN === '1';

/** Manila's date, `days` from today, as YYYY-MM-DD. */
function manilaDate(days) {
  const at = new Date(Date.now() + 8 * 3600_000 + days * 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** Three trips for any truck, the shape of child 0003's schedule answer. */
function schedule() {
  return {
    items: [
      { bookingNumber: 'BK-2026-0418', jobOrderNumber: 'JO-2026-0142', serviceDate: manilaDate(1), dispatchTime: '06:30', status: 'CONFIRMED' },
      { bookingNumber: 'BK-2026-0423', jobOrderNumber: null, serviceDate: manilaDate(3), dispatchTime: null, status: 'PENDING' },
      { bookingNumber: 'BK-2026-0431', jobOrderNumber: 'JO-2026-0157', serviceDate: manilaDate(6), dispatchTime: '14:00', status: 'CONFIRMED' },
    ],
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub');
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const line = `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`;
    if (down) {
      console.log(`${line} -> 503 (down)`);
      return send(res, 503, { code: 'BMS_DOWN' });
    }
    if (req.method === 'GET' && /^\/bms\/integrations\/vrms\/vehicles\/[^/]+\/schedule$/.test(url.pathname)) {
      console.log(`${line} -> 200`);
      return send(res, 200, schedule());
    }
    if (
      req.method === 'POST' &&
      ['/bms/integrations/vrms/repair-updates', '/bms/integrations/vrms/expedite-answers'].includes(url.pathname)
    ) {
      console.log(`${line} -> 202 ${raw}`);
      return send(res, 202, { received: true });
    }
    console.log(`${line} -> 404`);
    return send(res, 404, { code: 'NOT_FOUND' });
  });
}).listen(PORT, () => console.log(`BMS stub on :${PORT}${down ? ' (answering 503)' : ''}`));
