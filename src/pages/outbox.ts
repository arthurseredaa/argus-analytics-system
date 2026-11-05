// Page: the browser outbox that keeps step events until the server accepts them, as a JavaScript string for the quiz page.
// Implements ADR 0005 (client-generated event ids make a resend safe); serves ID-1, TEST-3, NFR-4, R-3, R-12, R-14.
// Unsent events expire after maxAgeMs (one day on the quiz page).
// Plain browser JavaScript without a build step. Unit-tested in Node by evaluating the string (tests/unit/outbox.test.ts).
export const OUTBOX_SCRIPT = `
function createOutbox(opts) {
  var list = [];
  var inFlight = false;
  var retryTimer = false;
  var setTimer = opts.setTimer || (typeof setTimeout === "function" ? setTimeout : null);
  var now = opts.now || Date.now;

  // The outbox covers short outages. An event older than opts.maxAgeMs (by its client_time) is
  // dropped unsent: it arrives too late to matter.
  function fresh(event) {
    if (!opts.maxAgeMs || !event || typeof event.client_time !== "number") return true;
    return now() - event.client_time <= opts.maxAgeMs;
  }

  try {
    if (opts.storage) {
      var saved = JSON.parse(opts.storage.getItem(opts.key) || "[]");
      if (Array.isArray(saved)) list = saved.filter(fresh);
    }
  } catch (e) {
    list = [];
  }

  function save() {
    try {
      if (opts.storage) opts.storage.setItem(opts.key, JSON.stringify(list));
    } catch (e) {
      // Storage is full or blocked: the outbox keeps working in memory.
    }
  }

  // 2xx to 4xx are final answers; 408, 429 and 5xx mean "try again later".
  function isFinal(status) {
    return status >= 200 && status < 500 && status !== 408 && status !== 429;
  }

  // Without this the outbox retries only on the next event, a reload or "online", so a 503 on the
  // last event of a visit could wait for ever. One timer at a time, 30 seconds after a retryable outcome.
  function retryLater() {
    if (retryTimer || !setTimer) return;
    retryTimer = true;
    setTimer(function () {
      retryTimer = false;
      flush();
    }, 30000);
  }

  function flush() {
    if (inFlight) return;
    var before = list.length;
    list = list.filter(fresh);
    if (list.length !== before) save();
    if (list.length === 0) return;
    var event = list[0];
    inFlight = true;
    var request;
    try {
      request = Promise.resolve(opts.send(event));
    } catch (e) {
      request = Promise.reject(e);
    }
    request.then(
      function (status) {
        inFlight = false;
        if (!isFinal(status)) {
          retryLater();
          return;
        }
        // The event may have been dropped by the cap while it was in flight.
        var at = list.indexOf(event);
        if (at !== -1) list.splice(at, 1);
        save();
        flush();
      },
      function () {
        inFlight = false;
        retryLater();
      }
    );
  }

  function enqueue(event) {
    list.push(event);
    if (list.length > opts.cap) list = list.slice(list.length - opts.cap);
    save();
    flush();
  }

  function pending() {
    return list.slice();
  }

  return { enqueue: enqueue, flush: flush, pending: pending };
}
`;
