# Glossary

Terms that mean something specific in this project. Other documents use these words in exactly this sense and do not introduce synonyms. Each entry names the document or id it comes from.

| Term | Meaning | Source |
|---|---|---|
| Prelander | The landing page with the quiz. The spec says "landing page"; both words mean the same page here. Several prelanders can exist; each has a prelander id in the path. | BIZ-1, A-6, Q-3 |
| Visit | One load of the prelander page. Each load gets a new visit id. Drop-off is computed between steps within the same cohort, so a visit never times out. | Q-26 |
| Click | A transition the user made from our redirect endpoint to a partner offer. Each click has a random, non-guessable click id, which is the key a partner's postback must carry back. Stored before the redirect is sent. | R-6, R-11, Q-21 |
| Transition | Same as click. The spec says "transition to the partner"; in the MVP it is a 302 to the offer's `.example` URL, verified by the `Location` header. | OFF-10, OFF-11, A-5 |
| Postback | An HTTP request from a partner that reports a Lead or a Purchase for one of our clicks. It is correlated to the click, then to the user and the offer. | PB-1, PB-4 |
| Lead | A postback of type Lead that passed authentication and was correlated to a user. A quiz email is never a Lead. One Lead counts per user per offer. | offer-selection.md, Q-23, PB-6 |
| Purchase | A postback of type Purchase. Counted and attributed to the click id the partner sends back. It does not give a redirect right on its own. | Q-8, Q-21 |
| Current answers | The latest answer accepted by the server for step 1 (partner gender) and step 2 (partner ethnicity). All answer events are kept; only the latest counts. | offer-selection.md, Q-4 |
| Sufficient answers | Both step 1 and step 2 have a current answer. | offer-selection.md |
| Match | The offer's ethnicity equals the step 2 answer and its gender list contains the step 1 answer. | offer-selection.md |
| Specialised offer | Any offer in the catalog except the universal one. | A-2 |
| Universal offer | The one offer marked `any` for ethnicity, 007 in the given catalog. Used only when no active specialised offer matches, and never competes on EPU. | OFF-6, OFF-7, Q-7 |
| EPU | Expected revenue in USD per unique user sent to an offer. A constant from the catalog in the MVP. | OFF-2 |
| Reason code | The label stored with every selection result: `lead_return`, `best_epu`, `fallback_universal`, `no_offer`. Tests assert the code, not the UI text. | offer-selection.md |
| Lead return | A returning user with a Lead for an active offer is redirected at entry, before the prelander renders, and the quiz is skipped. "Skip the quiz" and "skip the prelander" mean this. | OFF-3, A-6, Q-21 |
| Started the quiz | Step 1 was shown (its `step_viewed` event, A-1). A visit redirected at entry (lead return) is recorded but not counted as started. | Q-13, Q-21 |
| Cohort report | A report keyed by the click date, with an "as of" time, so late postbacks change past days visibly. The finance view is keyed by postback date instead. | Q-12, R-7 |
| UserID | The identity the server assigns and recognises on a return visit. Email is never used as identity or to merge users. | ID-1, ID-3, Q-19 |
| EventID | A client-generated id on every event, used as the idempotency key against retries and double sends. | ID-1, R-3 |
