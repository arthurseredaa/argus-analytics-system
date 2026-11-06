# 0002. Identify users with a server-set first-party cookie

- Status: accepted (2026-11-04, Part 2 stage 1)
- Date: 2026-11-02
- Relates to: ID-1, ID-2, ID-3, QZ-3, Q-3, Q-19, Q-21, Q-27, Q-28, A-6, R-1, R-2, R-3, R-12, P-2

## Context

The spec gives every user a UserID and every event an EventID (ID-1), and asks us to tell users apart and recognise the same user on a return visit, with a method we propose and explain (ID-2). An entered email does not confirm identity (ID-3, QZ-3).

Recognition has to happen on the first request of a visit. Rule 1 sends a user with a Lead for an active offer straight to that offer, and our default for Q-21 and A-6 is a server-side 302 before the prelander renders. So the server needs the UserID when the browser asks for the page, before any of our JavaScript runs.

The same decision fixes where an EventID is created, which the retry and ordering rules in R-3 depend on.

## Constraints

- Cloudflare Workers serve the prelanders, so the Worker sees every page request and can set response headers.
- Prelanders sit under one registrable domain (Q-3 default). A cookie cannot be shared across different registrable domains.
- Cross-device identity is out of scope (Q-19 default), and email is never used to merge users.
- Browsers limit storage lifetime. Chrome caps a cookie's lifetime at 400 days from when it is set (Chrome 104 and later). Safari deletes all script-writable storage, localStorage included, after seven days of Safari use without interaction on the site.
- The UserID works like a bearer credential: whoever presents it gets that user's Lead redirect. It must not leak to URLs, logs or partners (R-12, P-2).
- Whether EU visitors must consent before the cookie is set is a legal question (Q-27).

## Options considered

1. Server-set first-party cookie. On a request without a valid identity cookie, the Worker generates a random UserID (`crypto.randomUUID()`) and returns it in a `Set-Cookie` header with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, the registrable domain and a 400-day `Max-Age`. The browser sends it with every later request, including the first page request of a return visit. Cost: none beyond a few lines of code. Where it breaks: a user who clears cookies, opens a private window or switches device becomes a new user, so unique users are overcounted and the Lead return rule misses them (R-1). Prelanders on another registrable domain get a different UserID (R-2).
2. ID in localStorage. Our JavaScript generates the ID, keeps it in localStorage and adds it to every event. Cost: none. Where it breaks: localStorage is not sent with the page request, so the server cannot recognise a returning user before the page renders, and the redirect before render (Q-21) is impossible; the page would have to load, run the script and redirect, which adds a round trip and a visible flash. Safari deletes the ID after seven days without a visit, so a user returning after a week is new. The ID is also whatever the client says it is.
3. Email as identity. Cost: none. Where it breaks: the spec rules it out. Anyone who types an earlier user's email would get that user's Lead redirect (ID-3), and the email only arrives at quiz step 3, after the point where the user has to be recognised. It would also turn a personal data field into a lookup key.
4. Cookie with a localStorage copy. The cookie is primary; a copy in localStorage restores it when the cookie is cleared. Where it breaks: users who clear cookies usually clear site data as a whole, Safari deletes the copy after seven days anyway, and the restore path is a second place where the ID can be read by scripts, which gives up the protection of `HttpOnly`.
5. Browser fingerprinting. A script hashes browser traits: canvas and WebGL rendering, installed fonts, screen size, time zone, language, user agent. Where it breaks: it is built to recognise the same browser after its cookies are cleared, and across different browsers on one device the traits differ, so the hash differs too. Identical devices give near-identical fingerprints (two iPhones of the same model on the same iOS version), and Safari and Firefox add noise on purpose. A false merge is worse for us than a missed return: rule 1 would send a stranger to another user's offer, while a missed return only means the quiz is shown again. Under EU rules fingerprinting needs the same consent as a cookie, so it would not even avoid Q-27.

In-app browsers (Instagram, TikTok, Facebook) keep a cookie store separate from the system browser, so a user who taps "open in browser" arrives without our cookie. Carrying the identity over in a one-time token in the URL was considered and left out: it puts an identity credential in a URL, which this ADR forbids, and it works only when the user follows our own link.

Ad click IDs (`gclid`, `fbclid`, `ttclid`) and UTM tags in the landing URL were considered as identity and left out. The ad platform issues a new click ID for every ad click, so two clicks by one person carry two IDs, and UTM tags describe a campaign, not a person. The one case where they link two of our UserIDs is an in-app visit reopened in the system browser with the same URL, but a link with a click ID can also be copied and sent to someone else, so the match is good enough for analytics at most. Storing them for attribution is Q-28.

## Decision

Option 1. It is the only option that gives the server the UserID on the first request of a visit, which the redirect before render needs, and `HttpOnly` keeps the ID out of reach of scripts on the page. On `workers.dev`, a public suffix, the cookie is host-only with no `Domain`; the registrable-domain cookie applies once prelanders run on our own domain.

Details that belong to this decision:

- The cookie value is a random UUID and nothing else: no email, no counter, no signature. A value that is not a well-formed UUID is treated as a missing cookie and replaced. Signing the value was considered and left out: a random 122-bit ID cannot be guessed, and a copied signed cookie works just as well as a copied plain one, so a signature would add key rotation without stopping the real risk.
- Every response to a page request re-sets the cookie with a fresh `Max-Age`, so an active user does not expire after 400 days.
- The server takes the UserID from the cookie only. A `user_id` in an event body is ignored, so a client cannot write events as another user.
- The UserID never appears in a URL, a log line or a partner request. Partners get the random click ID instead (P-2).

EventID rule: an EventID is created where the event is created.

- A browser event gets its EventID in the browser (`crypto.randomUUID()`) at the moment the event is created, and keeps it on every resend until the server accepts it. A retry then carries the same EventID and is dropped as a duplicate (R-3). If the server assigned the id, every resend would get a new one and become a duplicate.
- An event the server creates itself, such as offer selection or the redirect to an offer, gets its EventID from the Worker.
- Postbacks have their own key, (partner, type, transaction ID), set in ADR 0007 (P-4).

## Consequences

- Easier: one source of identity for every request, available before render, with no client code needed for it.
- Easier: Lead return, current answers and the funnel all join on one UserID from the same cookie.
- Harder: we cannot recognise a person across devices, across browsers (an in-app browser and the system browser count as two) or after cookies are cleared. The design states this limit, and the metrics document has to say that "unique users" means unique browsers.
- Rules use deterministic identity only. A probabilistic estimate, such as the share of people who arrive from two devices, may appear in analytics later, because a report can carry an error and a redirect cannot. If the company asks for cross-device identity (Q-19), the deterministic routes are a partner user ID returned in the postback and an email confirmed by a link, both described there.
- Harder: every prelander must be served under the same registrable domain, or it becomes its own population of users (Q-3).
- Watch: the share of page requests that arrive without the identity cookie, against the share of visits that are expected to be returns. A sudden rise means cookies are being lost (a domain change, a browser change).
- Open: if Q-27 is answered "consent is required", the cookie is set only after consent, and a visitor who declines is a new user on every visit with no Lead return.

## Verification

- `ID-1 first visit creates a user id`: a request without a cookie gets a `Set-Cookie` with a UUID.
- `ID-2 second visit with the same cookie keeps the user id` and `ID-2 R-1 visit without the cookie creates a new user`.
- Cookie attributes test: the `Set-Cookie` header has `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and `Max-Age=34560000` (400 days), and the value matches the UUID format.
- `ID-2 malformed cookie value is replaced`: a cookie holding `not-a-uuid` gets a new UserID.
- `ID-2 user id in the event body is ignored`: an event with another user's id in its body is stored under the cookie's UserID.
- `ID-3 earlier user's email in a new browser gives no lead return`.
- `R-3 resent event keeps its event id and is stored once`.
- The R-12 log check also searches captured logs and URLs for the test user's UserID.

## References

- `docs/requirements/requirements.md`: ID-1 to ID-4, QZ-3.
- `docs/requirements/open-questions.md`: Q-3, Q-19, Q-21, Q-27, A-6.
- `docs/requirements/risks.md`: R-1, R-2, R-3, R-12.
- `docs/testing/acceptance-checks.md`: cards ID-1, ID-2, ID-3.
- Chrome cookie lifetime cap of 400 days, checked 2026-11-02: https://developer.chrome.com/blog/cookie-max-age-expires
- Safari deletes script-writable storage after seven days without interaction, checked 2026-11-02: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- `Set-Cookie` attributes: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie

## Outcome

2026-11-04, stage 1 of Part 2. The decision held.

- The server sets the `uid` cookie on the first response: HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000, no Domain, so on workers.dev it is host-only.
- A malformed cookie value is replaced with a new user id.
- A user id sent in the completion body is ignored.
- No D1 row exists until the user completes the quiz.

Tests that passed: "ID-1 first visit sets a user id cookie and writes no D1 row", "ID-2 cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000 on the page", "ID-2 second visit with the same cookie keeps the user id", "ID-2 R-1 visit without the cookie creates a new user", "ID-2 malformed cookie value is replaced", "ID-2 user id in the completion body is ignored", "ID-2 the 500 path from onError still carries the identity cookie".

What did not hold: nothing found so far. A new ADR is not needed.
