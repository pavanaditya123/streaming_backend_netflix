# Frame browser app

Frame is the browser interface for the existing streaming microservices. It is
plain HTML, CSS, and JavaScript served by the API gateway on port 3000. No bundler,
frontend development server, external fonts, image service, or API keys are needed.
The container already copies the gateway's `public/` directory with the services.

## Start locally

Use Node.js 22 or newer, then run:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Create an account with an email and a password containing
at least eight characters, a letter, and a number. Select a plan to enable playback
sessions. The memory adapters reset accounts, subscriptions, and history when the
process restarts. Docker Compose uses persistent PostgreSQL instead.

## Browser features

- Discover: personalized rails, trending titles, and continue-watching positions.
- Movies and series: paginated catalogs and title details, including cast, genre,
  maturity, and eligible plans.
- Search: natural-language requests using the recommendation service.
- Plans: three monthly plans, simulated checkout, and polling until the subscription
  saga activates or fails. No card number is requested.
- Playback demo: start a session, adjust and save its viewing position, resume from
  a saved position, and end the session. Open sessions remain manageable in My account.
- My account: edit display name, inspect subscriptions and payment history, cancel a
  plan, read notifications, and end active playback sessions.
- Authentication: register, sign in, and sign out. The bearer token lives in
  `sessionStorage`, is cleared on sign-out or an authentication failure, and is sent
  only to the same-origin gateway API.

## Implementation

`services/api-gateway/public/index.html` owns the page shell and accessible dialog.
`styles.css` defines the responsive layout and locally rendered abstract title cards.
`app.js` renders hash routes and calls `/api/v1`. Dynamic text is HTML-escaped;
requests have timeouts; page versions prevent stale navigation responses replacing
new pages. API failures produce inline errors or a live status message.

The gateway applies a Content Security Policy to static assets: scripts, styles,
and API calls come from the same origin; framing is blocked. Unknown paths continue
to return the backend's JSON 404 instead of silently returning the app shell.
Downstream services still verify their internal credentials and forwarded identity.
Saga, payment, and profile detail lookups enforce ownership.

History writes invalidate personalized recommendation and home caches after the
write completes. Continue-watching cache entries include the requested limit.
Recommendation rails attach `resumeAtSeconds` and `progressPercent` to catalog
items, so the browser can resume without reconstructing a history entry.

## Validation

```sh
npm run lint
npm test
npx playwright install chromium
npm run test:browser
```

Playwright starts a separate stack on ports 4300–4308 and runs the complete viewer
journey at desktop and mobile sizes. It checks resume position, account updates,
sign-out and login, browser errors, and horizontal overflow. CI installs Chromium
and runs the same journeys. For Linux machines lacking browser system packages,
`npx playwright install --with-deps chromium` installs the required packages too.

## Demo boundaries

The project has no licensed movie files, transcoding pipeline, DRM, CDN, or download
implementation. Playback controls simulate the viewing position while exercising
the real session and event APIs. The backend's manifest URL is a placeholder and is
not loaded by the browser. Subscription prices and quality limits come from the
backend; billing and outbound notification delivery remain simulated. Cancelling a
plan prevents starting new sessions; it does not terminate existing sessions.

This is a local portfolio application. A deployment accepting real users or money
requires separate work on payment integration, secrets and network configuration,
media delivery, durable event publication, and concurrency controls.
