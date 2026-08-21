# Uploading digitpredictor to GitHub

## A. Create the repository

On GitHub, create a new empty repository called:

`digitpredictor`

Do not upload the ZIP as a single file. Upload the files/folders inside this package.

## B. Upload

You can use GitHub's web interface:

1. Open the new repository.
2. Choose **Add file -> Upload files**.
3. Drag the contents of this folder into the upload area.
4. Commit the files.

## C. Put the app online

GitHub stores the code; it does not run the Node.js backend.

Connect the GitHub repository to a Node.js host. The included `render.yaml` is an optional starting point for a Render deployment.

Use:

- Build: `npm install`
- Start: `npm start`

Set the secret environment variables in the hosting provider's dashboard.

## D. Connect the domain

After the host gives you its public service URL:

1. Add your custom domain in the host's dashboard.
2. Add the DNS record(s) requested by the host at your domain registrar.
3. Wait for DNS propagation.
4. Confirm HTTPS works.
5. Test the application through the custom domain.

## E. Do not commit secrets

Never upload:

- `.env`
- `SESSION_SECRET`
- `TRONGRID_API_KEY`
- private keys
- database files containing real customer data

The `.gitignore` file is included to help prevent accidental commits.

## F. Final production test

Before selling access:

- Register a new account.
- Log in and log out.
- Confirm the Deriv live tick stream works.
- Confirm historical ticks load.
- Confirm the displayed backtest is calculated from the loaded sample.
- Submit a real test payment transaction.
- Confirm the backend validates the correct USDT contract, destination and amount.
- Confirm the correct entitlement is activated.
- Submit the same transaction hash again and confirm it is rejected.
- Confirm a user without an entitlement cannot access paid features.
