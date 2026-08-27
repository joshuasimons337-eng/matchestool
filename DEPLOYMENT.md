# matchestool — final deployable package

This folder is the merged application: the public landing page/frontend is served by the Node/Express backend in `server.js`.

## What is included
- `public/index.html` — landing page, account UI, signal dashboard and payment UI.
- `server.js` — authentication, sessions, Deriv historical-data proxy, TRC20 verification and entitlements.
- SQLite persistence under `data/`.
- `package.json` and `.env.example`.

## Before production
1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set a random `SESSION_SECRET` of at least 32 characters.
5. Set `NODE_ENV=production`.
6. Set `COOKIE_SECURE=true` when served over HTTPS.
7. Set `TRONGRID_API_KEY` for production TRON/TronGrid verification.
8. Keep `.env` private and never upload it to GitHub.
9. Run `npm test`.
10. Start with `npm start`.
11. Put the app behind HTTPS (for example, a reverse proxy/managed host) and point your domain DNS at the host.

## Payment configuration
Receiving address:
`TA3VbsQJKS5AiMG8gGJaPj8kcfDdBikDao`

USDT TRC20 contract:
`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`

Products:
- Matches: 100 USDT
- Over/Under: 100 USDT
- Full Access: 200 USDT

The server verifies a confirmed TRC20 Transfer event, the USDT contract, destination address, and exact product amount before activating the entitlement. It rejects a transaction hash that has already been submitted by another account.

## Deriv
This is a signal-only product. It does not use Deriv OAuth and does not execute trades. Public market data is obtained from Deriv's public WebSocket. The server also proxies `ticks_history` to the browser through `/api/history`.

## Accuracy
The dashboard calculates an observed rolling-window backtest from the returned historical ticks. It does not claim or guarantee 90%/99% accuracy.

## Important production note
SQLite is suitable for a small single-instance deployment. If you scale to multiple server instances, move the session/user/payment store to a managed database and shared session strategy.
