// Page: the quiz as server-rendered HTML with a small inline script.
// Implements the "Quiz flow" decision of docs/plans/part2-mvp-stages.md (no ADR: reversible); serves QZ-1, QZ-2, QZ-7, OFF-8, OFF-10.
// The script only shows steps and posts the completion. The server decides the offer.
import { resolveNext, type Flow, type Step } from "../domain/flow.ts";

const NO_OFFER = "No offer available";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// "{gender}" in a wording becomes a span the script fills with the answer.
function wordingHtml(wording: string): string {
  return wording
    .split(/(\{[^{}]+\})/)
    .map((part) =>
      /^\{[^{}]+\}$/.test(part)
        ? `<span data-answer="${esc(part.slice(1, -1))}"></span>`
        : esc(part),
    )
    .join("");
}

function stepHtml(step: Step, hidden: boolean): string {
  const open = `<section data-step="${esc(step.key)}"${hidden ? " hidden" : ""}>`;
  const title = `<h2>${wordingHtml(step.wording)}</h2>`;
  if (step.kind === "email") {
    return `${open}${title}
  <form data-email-form method="post" novalidate>
    <input type="email" name="email" required maxlength="254" autocomplete="email" aria-label="Email">
    <button type="submit">Continue</button>
    <p data-error hidden>Something went wrong. Please try again.</p>
  </form>
</section>`;
  }
  const buttons = (step.options ?? [])
    .map(
      (o) =>
        `<button type="button" data-value="${esc(o.value)}" data-next="${esc(resolveNext(step, o.value) ?? "")}">${esc(o.label)}</button>`,
    )
    .join("\n    ");
  return `${open}${title}
  <div class="options">
    ${buttons}
  </div>
</section>`;
}

const SCRIPT = `
(function () {
  var root = document.querySelector("main");
  var prelander = root.dataset.prelander;
  var answers = {};

  function show(key) {
    document.querySelectorAll("section[data-step]").forEach(function (s) {
      s.hidden = s.dataset.step !== key;
    });
  }
  function showResult(name) {
    document.querySelectorAll("section[data-step]").forEach(function (s) { s.hidden = true; });
    document.querySelectorAll("section[data-result]").forEach(function (s) {
      s.hidden = s.dataset.result !== name;
    });
  }
  function fill() {
    document.querySelectorAll("[data-answer]").forEach(function (el) {
      el.textContent = answers[el.dataset.answer] || "";
    });
  }

  document.querySelectorAll("button[data-value]").forEach(function (button) {
    button.addEventListener("click", function () {
      answers[button.closest("section").dataset.step] = button.dataset.value;
      fill();
      if (button.dataset.next) show(button.dataset.next);
    });
  });

  var form = document.querySelector("[data-email-form]");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var submit = form.querySelector("button");
    var error = form.querySelector("[data-error]");
    var input = form.querySelector("input");
    if (!input.value || !input.checkValidity()) {
      error.hidden = false;
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    fetch("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prelander_id: prelander, answers: answers, email: input.value })
    }).then(function (res) {
      if (!res.ok) throw new Error("rejected");
      return res.json();
    }).then(function (offer) {
      if (!offer.offer_id) return showResult("none");
      var box = document.querySelector("section[data-result='offer']");
      box.querySelector("[data-offer-name]").textContent = offer.name;
      box.querySelector("[data-offer-url]").textContent = offer.url;
      box.querySelector("a").href =
        "/go/" + encodeURIComponent(offer.offer_id) + "?prelander=" + encodeURIComponent(prelander);
      showResult("offer");
    }).catch(function () {
      error.hidden = false;
      submit.disabled = false;
    });
  });
})();
`;

export function renderQuizPage(flow: Flow, prelanderId: string): string {
  const steps = flow.steps.map((s) => stepHtml(s, s.key !== flow.first)).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quiz</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 32rem; margin: 0 auto; }
  .options { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button, input { font: inherit; padding: 0.6rem 1rem; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 0.5rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main data-prelander="${esc(prelanderId)}">
${steps}
<section data-result="offer" hidden>
  <h2 data-offer-name></h2>
  <p data-offer-url></p>
  <a href="#">Continue to the offer</a>
</section>
<section data-result="none" hidden>
  <h2>${NO_OFFER}</h2>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
