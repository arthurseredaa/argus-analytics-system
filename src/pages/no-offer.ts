// Page: the no-offer message, shown by /go and by entry when selection finds no offer.
// Implements ADR 0004 (step 7 of selection); serves OFF-8.
export function renderNoOfferPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No offer available</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 1rem; }
  main { max-width: 32rem; margin: 0 auto; }
</style>
</head>
<body>
<main>
<h2>No offer available</h2>
</main>
</body>
</html>
`;
}
