# matchestool

Full-stack digit signal application.

## Important: GitHub vs. hosting

This repository is **GitHub-ready**, but GitHub Pages cannot run the Node.js backend in `server.js`.

Use GitHub as the source-code repository, then connect the repository to a Node.js-capable hosting provider (for example, Render, Railway, or another service that runs `npm start`).

The production architecture is:

GitHub repository -> Node.js host -> your domain -> matchestool

The frontend is served by the same Express server, so you do not need a separate static-site deployment.

## Repository structure

```text
matchestool/
├── public/
│   └── index.html
├── data/
│   └── .gitkeep
├── server.js
├── server.test.js
├── package.json
├── .env.example
├── .gitignore
├── DEPLOYMENT.md
└── README.md
```

## Local test

Requirements: Node.js 20+

```bash
npm install
npm test
npm start
```

Then open:

`http://localhost:3000`

## Production environment variables

Create these on the hosting provider, NOT in GitHub:

```text
NODE_ENV=production
SESSION_SECRET=<long-random-secret>
COOKIE_SECURE=true
TRONGRID_API_KEY=<your-TronGrid-production-key>
```

Never commit `.env`.

## Product configuration

- Matches: $100 / 100 USDT
- Over/Under: $100 / 100 USDT
- Full Access: $200 / 200 USDT
- USDT TRC20 receiving address:
  `TA3VbsQJKS5AiMG8gGJaPj8kcfDdBikDao`

## Deriv

The application is signal-only. It uses Deriv public market data and does not execute trades or use Deriv OAuth for this product.

## Payment verification

The backend verifies the submitted TRON transaction before granting an entitlement. A transaction hash typed into the form does not itself unlock a product.

## Accuracy

The dashboard displays an observed historical rolling-window backtest from the returned tick sample. It does not advertise a guaranteed 90% or 99% accuracy rate.

## GitHub upload

1. Create a new GitHub repository named `matchestool`.
2. Upload the **contents of this folder** (not the ZIP file itself).
3. Commit the files to the repository.
4. Connect the repository to your Node.js hosting provider.
5. Add the production environment variables there.
6. Deploy with:
   - Build command: `npm install`
   - Start command: `npm start`
7. Point your domain DNS to the deployed application.
8. Enable HTTPS.
9. Test registration, login, Deriv data, payment verification, and entitlement activation before accepting customers.

### Do not use GitHub Pages for the full application

GitHub Pages is suitable for the static landing page only. It cannot run `server.js`, so it cannot provide the authentication, payment verification, entitlement, or backend Deriv proxy functionality.
