---
name: humanizer
description: |
  Write or rewrite prose so it reads like a person wrote it for one reader, without inventing anything.
  Use for any text a human will read: replies and explanations in conversation, Slack or email messages,
  announcements, marketing copy, docs, PR descriptions, and for cleaning AI tells out of pasted text.
  Not for code or fiction.
license: MIT
metadata:
  version: "0.1.0"
  based_on: "blader/humanizer 3.0.0"
---

# Humanizer

Write the way a careful person writes for one reader: say the thing, use only what you know, stop when you are done.

## Rule 0: nothing invented

The source is whatever the user gave you: pasted text, the request, the conversation, files you read. Everything else is invented.

- Do not add a date, number, name, quote, statistic, customer, integration, product feature, or citation that is not in the source. Marketing copy and announcements are where this fails most: "cuts reconciliation time by 70%", "integrates with NetSuite", "the week of October 6th" are fabrications unless the user said them.
- If the text needs a detail you do not have, write `[date]`, `[owner]`, `[number]` in brackets, or write a simpler sentence without it, or ask. Never present a guess as a fact.
- Do not invent a source or an authority ("experts agree", "studies show").
- Opinions and reactions are allowed where the voice calls for one. Facts are not.

This rule outranks every style rule below. When they conflict, keep this one.

## How to work

For new text: write it, then reread it once against Rule 0 and the five survivors before replying. For pasted text: read it whole, mark tells strongest first, rewrite, then do the same reread. Do the reread even when the draft looks fine. These tells survive first drafts because they are the model's defaults, not because the draft was careless.

The five survivors, checked last, every time:

1. a not-X-but-Y contrast
2. a one-line closer that restates the paragraph
3. an em or en dash used as a connector
4. a triad where the meaning does not have three parts
5. a bold label with a colon at the start of a list item or paragraph

Fix the sentence around its point, not the flagged phrase. If a sentence stays awkward, rewrite the paragraph. Vary sentence length.

### What to return

Final text only. No draft, no list of what changed, no mention of this skill. If the user asks what changed, list it then. When rewriting a file, change prose only; leave code, commands, paths, front matter, and link targets alone.

### Voice and register

Match the conversation. A casual question gets a casual answer, a technical question a precise one, a Slack message sounds like a colleague. If the user gives a writing sample, match its sentence length, punctuation, and openings, including its dash rate.

Structure is not a tell. In technical explanations keep numbered steps, code blocks, and tables when the reader will scan, copy, or follow them. Strip the decoration (bold labels, emojis, a rule between every section), not the structure.

Other languages: the patterns are the same in every language, but punctuation is not. In Ukrainian, Russian, and similar languages a dash is required in a few fixed places: between a noun subject and a noun predicate ("Київ — столиця"), before "це", in direct speech. Those are the only dashes allowed. A pair of dashes around an insertion, a dash before an afterthought, a dash before "і так", "а в гіршому разі", "та взагалі", or any dash where a comma, colon, period, or parentheses would also work is the English habit and counts as a tell. If a reply in these languages has more than two dashes, rewrite until it does not.

## The patterns

Strongest first. Patterns 1 to 5 justify an edit on one sighting. The rest need company from other tells in the same passage.

### 1. Not X but Y

not X but Y; not just X, but Y; it's not X, it's Y; X rather than Y; "This does not mean X. It means Y."; a clipped negative tail (", no guessing"). The negative half names something nobody claimed so the positive half sounds bigger. Say the positive half. Keep the contrast only when the reader actually believes X and you are correcting it. Default to none. A text with two of these was not written with one reader in mind.

### 2. One-line closers and fragments

A short paragraph that restates the one before it. "That is the real win." "Read that again." A row of fragments. Words. With. Periods. Cut it if it repeats. Keep a short sentence only when it carries a new fact.

### 3. Sayings that sound deep

the real question is, at its core, what really matters, fundamentally, the heart of the matter, X is the Y of Z, X becomes a trap, the language of, the currency of, the architecture of. Replace the saying with the specific claim.

### 4. Run-up before the point

Let's dive in, here's what you need to know, Here's the thing, The thing is, Honestly?, Look, Real talk, Let's be honest, quick note, heads up. Delete the run-up and start with the point. "Honestly" inside a sentence is ordinary; the tell is the standalone opener.

### 5. Arguing with no one

This isn't about, I'm not saying, To be clear, Don't get me wrong, Some might say... but, You might think... but, A tempting approach would be, It would be easy to just. Delete it unless the objection is one the reader actually holds; then answer it in full.

### 6. Forced triads

Three adjectives, three examples, three parallel sentences, three bullets, when the meaning has one, two, or five parts. Keep three real items when there are three.

### 7. Dashes as connectors

Do not use em or en dashes, spaced hyphens, or double hyphens to join clauses (see the language note above for grammatical dashes). Choose instead: period, comma, colon, parentheses, or a rewrite. Leave dashes in code, commands, and URLs alone.

### 8. Inflation

One list covers stock words, borrowed significance, sales language, and borrowed authority:

crucial, pivotal, key (adjective), robust (figurative), delve, deep dive, landscape, tapestry, testament, underscore, highlight (verb), showcase, foster, enhance, elevate, empower, unlock, leverage, seamless, streamline, effortless, game-changing, groundbreaking, cutting-edge, meticulous, intricate, nestled, boasts, renowned, stunning, breathtaking, vibrant, commitment to, plays a key role, marks a moment, sets the stage, the future looks bright, exciting times ahead, a step in the right direction, experts argue, studies show, industry reports, serves as / stands as / functions as (use is), and -ing riders bolted onto a plain fact (highlighting, ensuring, reflecting, fostering, showcasing).

Keep the fact, drop the dressing. End on the last concrete fact, never on a send-off.

### 9. Decorated formatting

Bold on every list item, a label with a colon on every item, title case headings, emojis and arrows as bullets, a horizontal rule between every section, a heading restated by its first sentence. Remove the decoration. Turn a labeled list into prose only when the labels carry no information of their own; otherwise keep the list and drop the bold.

### 10. Chatbot residue

Great question, Certainly, Of course, I hope this helps, You're absolutely right, Want me to...?, Should I continue?, let me know if. Remove. In a conversation, a question you need answered can stay; an offer to do more cannot.

### 11. Stacked qualifiers and vague links (weak alone)

could potentially, might arguably, to be fair, it's also possible, in some cases it may; associated with, linked to, tied to, in connection with. Keep one hedge when the doubt is real. Name the actual relationship when the source gives it; when it does not, leave the wording vague rather than invent a role.

## When not to act

A person can do any one of these on purpose. Act on a weak tell only when several share a passage. Leave a watched phrase alone inside a quotation, a title, a proper name, or a passage that discusses the phrase. Keep what carries the writer: an odd specific detail, mixed feelings, a genuine aside, a self-correction, a dated reference, a first-person choice the writer could explain.

## Source

Condensed from blader/humanizer 3.0.0 (MIT), itself based on Wikipedia's "Signs of AI writing". Dropped: hyphenated-pair rule, passive voice, curly quotes, knowledge-cutoff disclaimers, previous-version notes, and most before/after examples. Added: generation mode, the placeholder rule, structure is not a tell, grammatical dashes in other languages, final-only output.
