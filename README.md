# VoteSecure PK

## Deploy to Vercel

From this folder, sign in with `vercel login` and run `vercel link`. Select
your account and name the project `votesecure`. Create a hosted PostgreSQL
database and set the following Production environment variables in the project
settings. Use synthetic voters and ballots for this demo.

- `DATABASE_URL` is the hosted PostgreSQL connection string. For a fresh demo,
  use an empty database so the application can create its tables.
- `ADMIN_KEY` is a private value of at least 20 characters.
- `ELECTION_KEYS_JSON` is the full JSON content from a dedicated election key
  file. Keep the same value for every deployment that uses this database.

Generate a separate key file for the hosted demo from the project directory:

```powershell
node --input-type=module -e "import { loadKeys } from './server/keys.mjs'; await loadKeys('.demo-data/vercel')"
Get-Content -Raw .demo-data/vercel/election-keys.json | vercel.cmd env add ELECTION_KEYS_JSON production --sensitive
```

Run `vercel deploy --prod`, then open the resulting URL and check
`/api/election` on the same domain. The online demo starts with its own election
state. Moving an existing election requires its database and matching keys.

VoteSecure PK is a local academic prototype of the Pakistan Digital Electoral Voting and Verification Platform. It uses React, a Node.js/Express API, and PostgreSQL. The academic ballot uses an email-verified account to authorize voting. A synthetic electoral roll remains available through the legacy verification API.

## Run locally

Install Node.js 22.13 or later and either Docker Desktop with Compose or PostgreSQL 16. From this folder, run the following in PowerShell.

```powershell
Copy-Item .env.example .env
npm.cmd install
docker compose up -d --wait
```

Set `ADMIN_KEY` in `.env` to a private local value of at least 20 characters before starting. Compose listens on loopback port 5435. For an existing PostgreSQL installation, create a dedicated empty demo database and set `DATABASE_URL` instead of running Compose. The app creates its schemas and seeds 24 eligible synthetic voters and three ineligible examples. Restart the app after upgrading to add the extra voters to an existing database.

Run `npm.cmd run dev` and open [http://localhost:5173](http://localhost:5173). For a built version, stop the dev processes, run `npm.cmd run build` and then `npm.cmd start`. Open [http://localhost:3000](http://localhost:3000).

## Demo walkthrough

1. Create a verified account or sign in under **Account**. Successful sign-in returns you to **Home**.
2. Select **Start voting** to open the ballot, then choose and review one candidate.
3. Confirm your choice and select **Download PDF receipt**. Use **Open PDF** to view and save it in a separate tab. For this academic election, a signed-in, email-verified account qualifies for one voting authorization.
4. To cast a ballot with a different account on the same device, sign out from **Account** and sign in to that account.
5. Open **Election admin**, enter the admin key, and close polls when ready. In **Results & audit**, verify the saved receipt against the published Merkle root and download the audit data.

To reopen polls for a fresh run, open **Election admin**, enter the admin key, type `RESET`, and select **Reset election and accounts**. The reset permanently deletes ballots, receipts, results, and voter registrations. Each voter must register again.

## Architecture

```mermaid
flowchart TD
    Browser["React browser"]
    Identity["Identity and credential API"]
    Intake["Encrypted ballot API"]
    Publish["Tally and public audit API"]
    Registry["PostgreSQL identity schema"]
    Box["PostgreSQL ballot schema"]
    Browser -->|"Signed-in account and blinded request"| Identity
    Browser -->|"Unblinded credential and ciphertext"| Intake
    Browser -->|"Receipt lookup and results"| Publish
    Identity --> Registry
    Intake --> Box
    Publish --> Box
```

| Component | Behavior |
| --- | --- |
| Account authorization | Checks the signed-in session and grants one authorization per registered CNIC per election. The legacy API still supports testing the synthetic roll. |
| Credential issuer | Issues an RFC 9474 blind RSA signature. The browser creates a random serial. The issuer sees a blinded request and stores one issuance per voter per election. |
| Ballot intake | Receives the credential and RSA-OAEP ciphertext. PostgreSQL enforces a single use of the serial across concurrent requests. An identical retry returns the original receipt. |
| Poll close | Serializes with active intake using PostgreSQL row locks. Decrypts the ballots, counts known options and records malformed ballots as invalid. Closing and publication commit together. |
| Audit | Signs the published tally and Merkle root with ECDSA. The browser verifies a Merkle inclusion proof. The export includes the ordered receipt hashes so an observer can recalculate the root. |

### Independent audit of the export

Keep the public audit key from the configured demo server before closing polls. In PowerShell, while the API is running:

```powershell
(Invoke-RestMethod http://127.0.0.1:3000/api/election).auditKey |
  ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii audit-public.jwk.json
```

Run `npm.cmd run audit -- votesecure-audit.json audit-public.jwk.json` using that key and the downloaded audit JSON. A receipt proves inclusion of an encrypted submission. The publication signature authenticates the operator's tally. Neither check independently proves that the tally matches the decrypted ballot contents.

## Checks

- `npm.cmd test` runs the dependency-free eligibility, encrypted tally, signature, and Merkle checks.
- `npm.cmd run test:integration` targets a running server connected to a **fresh demo database**. It creates two isolated account fixtures, casts two ballots, and closes the election. Configure the test server with a stable fixture ACCOUNT_DATA_KEY, an HTTP localhost ACCOUNT_ORIGIN, and unused fixture values for RESEND_API_KEY and ACCOUNT_EMAIL_FROM. The test covers signed-in CNIC matching, ineligible voters, duplicate issuance and casting, and published proofs.

## Prototype boundaries

- Identity and ballot routes use separate tables and data contracts in one API process. The ballot table has no voter identifiers. The demo operator controls all keys and can inspect ciphertext and process traffic. Timing/network correlation, coercion, and compromised devices remain out of scope.
- The prototype is a single-seat, final-ballot workflow. The proposal's homomorphic encryption, threshold trustees, paper override, re-voting, liveness and fraud detection remain future work.
- The API uses a PostgreSQL pool and has no in-memory voter sessions. Multiple local processes would need the same database, configuration, and election keys. Batch tallying and audit publication run in memory. The proposal's national-scale and throughput targets have not been measured.
- Use only the synthetic accounts. This is a localhost classroom demo. The seeded PINs are deliberately public, and election keys are saved to `.demo-data/` by default.

## References

- [Election Commission of Pakistan voter instructions](https://www.ecp.gov.pk/storage/files/2/ERp/Instructions%20for%20Voters%20Updated.pdf)
- [Elections Act, 2017, sections 26 and 27](https://www.ecp.gov.pk/storage/files/2/Elections%20Act%202017%20updated/Updated%20Elections%20Act%202017-231011-105435.pdf)
- [RFC 9474, RSA Blind Signatures](https://www.rfc-editor.org/rfc/rfc9474.html)
- [Cloudflare blind RSA implementation](https://github.com/cloudflare/blindrsa-ts)


### Start a fresh local showcase

Keep the existing database for its published results. Stop the local web and API
processes, then use a new database for the rehearsal or evaluator run. Open the
site in a new private browser window to start with fresh voting-tab state.

```powershell
docker compose up -d --wait
$demoDatabase = 'votesecure_demo_' + (Get-Date -Format 'yyyyMMdd_HHmmss')
docker compose exec -T postgres createdb -U votesecure $demoDatabase
if ($LASTEXITCODE -ne 0) { throw 'Could not create the demo database.' }
$env:DATABASE_URL = "postgresql://votesecure:votesecure_local@127.0.0.1:5435/$demoDatabase"
npm.cmd run dev
```

After stopping the demo processes, run `Remove-Item Env:DATABASE_URL` in the same
PowerShell window to return to the database configured in `.env` on the next start.

Start at **Home** to introduce the candidate lineup. Select **Start voting** to open the ballot, review a candidate selection, and confirm it. After
closing polls in **Election admin**, use **Results & audit** to paste or upload a
downloaded receipt and check inclusion.

### Account registration and sign-in

Open **Account** and enter your email, CNIC, name, and Pakistani mobile number.
Create a password on the signup form. Then enter the code from the email to
verify your address, open your account, and sign in. On later visits, sign in with your email and
password. Existing email-code accounts can use **Set or reset password**.
The same email, CNIC, or mobile number can only be used for one account.

**Remember me on this device** keeps the session for up to 30 days. Without it,
the session uses a browser-session cookie and expires on the server after eight
hours. Signing out ends the current session. Password resets revoke the
account's existing sessions.

The ballot uses the registered CNIC digest associated with the signed-in
account. The prototype grants one authorization per account per election.
This is an academic election and makes no official electoral eligibility check.

PostgreSQL stores keyed digests for email, CNIC, and mobile lookups, encrypted
names, salted password hashes, expiring email challenges and sessions, and
blind issuance records. An identity-side account digest limits authorization
to once per election. Ballot records store encrypted ballots, anonymous
credential hashes, and receipts. The email provider receives the destination
email and verification message.

Set `ACCOUNT_ORIGIN` to `http://localhost:5173` for local Vite or
`https://votesecure-kohl.vercel.app` in production. Reuse the existing stable
`ACCOUNT_DATA_KEY`. For a new database, generate and store it in the server environment:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` server-side to send verification
and password reset codes through Brevo. Use a sender verified in Brevo and an
API key with transactional email send permission. Alternatively, set
`RESEND_API_KEY` and `ACCOUNT_EMAIL_FROM` for Resend using a verified sending
domain. When both providers are configured, VoteSecure uses Brevo. Redeploy
after adding the production variables.
