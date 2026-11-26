import { randomInt, randomUUID } from 'node:crypto'
import express from 'express'
import { registerVoterAccounts } from './voter-accounts.mjs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ELECTION, preparedCredentialMessage, fromHex, hex, isDemoCnic, isHex, isReceiptCode, leafPayload } from '../shared/election.mjs'
import { MerkleTree } from '../shared/merkle.mjs'
import { eligibilityChecks, eligibilityError, hashPin, publish, safeEqual, sha256 } from './core.mjs'
import { database } from './database.mjs'
import { loadKeys, suite } from './keys.mjs'
import { createReceiptPdf } from '../src/receipt.mjs'

const { DATABASE_URL, ADMIN_KEY, PORT = 3000, KEY_DIRECTORY = '.demo-data', ELECTION_KEYS_JSON } = process.env
if (!DATABASE_URL || !ADMIN_KEY || ADMIN_KEY.length < 20) {
  throw new Error('Set DATABASE_URL and an ADMIN_KEY of at least 20 characters in .env.')
}
const db = database(DATABASE_URL)
if (process.env.VERCEL === '1' && !ELECTION_KEYS_JSON) {
  throw new Error('Configure ELECTION_KEYS_JSON before running on Vercel.')
}
const keys = ELECTION_KEYS_JSON ? JSON.parse(ELECTION_KEYS_JSON) : await loadKeys(KEY_DIRECTORY)
const keyFingerprint = sha256(JSON.stringify([
  keys.credential.publicKey.n, keys.credential.publicKey.e, keys.ballot.publicKey.n,
  keys.ballot.publicKey.e, keys.audit.publicKey.x, keys.audit.publicKey.y,
]))
let databaseReady
function initializeDatabase() {
  databaseReady ??= db.initialize(keyFingerprint).catch((error) => {
    databaseReady = undefined
    throw error
  })
  return databaseReady
}
const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' }
const issuer = await crypto.subtle.importKey('jwk', keys.credential.privateKey, algorithm, true, ['sign'])
const verifier = await crypto.subtle.importKey('jwk', keys.credential.publicKey, algorithm, true, ['verify'])
const app = express()
const api = express.Router()
const seat = ELECTION.seat

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function requireOpen(election) {
  if (election.closed_at) throw new HttpError(409, 'Voting is closed.')
}

async function electionRow(connection, lock = '') {
  const { rows } = await connection.query(
    `SELECT id, to_char(cutoff, 'YYYY-MM-DD') AS cutoff, closed_at, publication FROM ballot.elections WHERE COALESCE(series_id, id) = $1 ${lock}`, [ELECTION.id],
  )
  return rows[0]
}

app.disable('x-powered-by')
api.use(express.json({ limit: '8kb' }))
api.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
api.use(async (_req, res, next) => {
  try {
    await initializeDatabase()
    next()
  } catch (error) {
    console.error('Database initialization failed:', error.code ?? error.name)
    res.set('Retry-After', '3').status(503).json({
      error: 'The election database is temporarily unavailable. Please retry in a few seconds.',
    })
  }
})

const voterAccounts = registerVoterAccounts(api, db)

api.get('/election', async (_req, res) => {
  const election = await electionRow(db.pool)
  res.json({
    ...ELECTION,
    id: election.id,
    status: election.closed_at ? 'closed' : 'open',
    credentialKey: keys.credential.publicKey,
    ballotKey: keys.ballot.publicKey,
    auditKey: keys.audit.publicKey,
  })
})

function requireVoterAuthentication(voter, cnic, pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) throw new HttpError(400, 'Enter the six-digit PIN.')
  if (!voter || !safeEqual(hashPin(cnic, pin), voter.pin_hash)) throw new HttpError(401, 'CNIC or PIN did not match.')
}

async function requireRegisteredCnic(req, connection) {
  const result = await voterAccounts.checkRegisteredCnic(req, req.body?.accountCnic, connection)
  if (result.error) throw new HttpError(result.status, result.error)
  return result.cnicHash
}

api.post('/identity/verify', async (req, res) => {
  await requireRegisteredCnic(req, db.pool)
  const { cnic, pin } = req.body ?? {}
  if (!isDemoCnic(cnic)) {
    throw new HttpError(400, 'Enter a synthetic CNIC.')
  }
  const election = await electionRow(db.pool)
  requireOpen(election)
  const { rows: [voter] } = await db.pool.query(`
    SELECT pin_hash, to_char(dob, 'YYYY-MM-DD') AS dob, citizen, cnic_issued, registered, resident, legally_eligible, seat
    FROM identity.voters WHERE cnic = $1`, [cnic])
  requireVoterAuthentication(voter, cnic, pin)
  res.json({
    checks: eligibilityChecks(voter, election.cutoff, seat),
    problem: eligibilityError(voter, election.cutoff, seat),
  })
})

async function signBlindedCredential(blinded) {
  try {
    return hex(await suite.blindSign(issuer, fromHex(blinded)))
  } catch {
    throw new HttpError(400, 'The blinded credential request is invalid.')
  }
}

async function issueAccountCredential(req, workspace, blinded) {
  return db.transaction(async (client) => {
    const election = await electionRow(client, 'FOR SHARE')
    requireOpen(election)
    const { id } = election
    requireCurrentRun(req, id)
    const account = await voterAccounts.checkVotingAccount(req, client)
    if (account.error) throw new HttpError(account.status, account.error)
    if (!safeEqual(workspace, account.workspace)) throw new HttpError(409, 'Your signed-in account changed. Reopen Cast ballot.')
    const signed = await signBlindedCredential(blinded)
    const inserted = await client.query(`
      INSERT INTO identity.issuances (election_id, account_cnic_hash, blinded_message, blinded_signature)
      VALUES ($1, $2, $3, $4) ON CONFLICT (election_id, account_cnic_hash) DO NOTHING`,
    [id, account.cnicHash, blinded, signed])
    if (inserted.rowCount) return signed
    const { rows: [existing] } = await client.query(`
      SELECT blinded_message, blinded_signature FROM identity.issuances
      WHERE election_id = $1 AND account_cnic_hash = $2`, [id, account.cnicHash])
    if (existing?.blinded_message === blinded) return existing.blinded_signature
    throw new HttpError(409, 'This account already received a voting authorization. If a ballot is pending, return to the tab where you started it.')
  })
}

// Identity service receives synthetic identity and a blinded request. It never receives a ballot or serial.
api.post('/identity/credentials', async (req, res) => {
  const { cnic, pin, blinded, workspace } = req.body ?? {}
  if (workspace !== undefined) {
    if (!isHex(workspace, 32) || !isHex(blinded, 256)) throw new HttpError(400, 'Invalid voting authorization request.')
    const signature = await issueAccountCredential(req, workspace, blinded)
    return res.json({ signature })
  }
  if (!isDemoCnic(cnic) || !isHex(blinded, 256)) {
    throw new HttpError(400, 'Enter a synthetic CNIC and a valid credential request.')
  }
  const signature = await db.transaction(async (client) => {
    const election = await electionRow(client, 'FOR SHARE')
    requireOpen(election)
    const { id } = election
    requireCurrentRun(req, id)
    const accountCnicHash = await requireRegisteredCnic(req, client)
    const { rows: [voter] } = await client.query(`
      SELECT pin_hash, to_char(dob, 'YYYY-MM-DD') AS dob, citizen, cnic_issued, registered, resident, legally_eligible, seat
      FROM identity.voters WHERE cnic = $1 FOR UPDATE`, [cnic])
    requireVoterAuthentication(voter, cnic, pin)
    const problem = eligibilityError(voter, election.cutoff, seat)
    if (problem) throw new HttpError(403, problem)
    const { rows: [existing] } = await client.query(`
      SELECT blinded_message, blinded_signature, account_cnic_hash FROM identity.issuances WHERE election_id = $1 AND cnic = $2`, [id, cnic])
    if (existing) {
      if (existing.blinded_message !== blinded || existing.account_cnic_hash !== accountCnicHash) {
        throw new HttpError(409, 'This voter has already received a voting authorization.')
      }
      return existing.blinded_signature
    }
    const signed = await signBlindedCredential(blinded)
    const issued = await client.query(`
      INSERT INTO identity.issuances (election_id, cnic, blinded_message, blinded_signature, account_cnic_hash)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (election_id, account_cnic_hash) DO NOTHING`,
    [id, cnic, blinded, signed, accountCnicHash])
    if (!issued.rowCount) throw new HttpError(409, 'Your account has already received a voting authorization for this election.')
    return signed
  })
  res.json({ signature })
})

// Ballot service receives a credential and encrypted ballot. It never reads the identity schema.
api.post('/ballots', async (req, res) => {
  const { serial, prefix, signature, ciphertext, seat: requestedSeat } = req.body ?? {}
  if (requestedSeat !== seat) throw new HttpError(400, 'This credential is for a different constituency.')
  if (!isHex(serial, 32) || !isHex(prefix, 32) || !isHex(signature, 256) || !isHex(ciphertext, 256)) {
    throw new HttpError(400, 'The ballot or credential has an invalid format.')
  }
  const serialHash = sha256(fromHex(serial))
  const result = await db.transaction(async (client) => {
    const { id, closed_at } = await electionRow(client, 'FOR SHARE')
    const message = preparedCredentialMessage(id, seat, serial, prefix)
    if (!await suite.verify(verifier, fromHex(signature), message)) throw new HttpError(403, 'The voting credential is invalid.')
    const receipt = sha256(leafPayload(id, seat, ciphertext))
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const receiptCode = Array.from({ length: 6 }, () => String.fromCharCode(65 + randomInt(26))).join('')
      if (!closed_at) {
        const inserted = await client.query(`
          INSERT INTO ballot.ballots (election_id, serial_hash, receipt, ciphertext, receipt_code)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [id, serialHash, receipt, ciphertext, receiptCode])
        if (inserted.rowCount) return { status: 201, receipt, receiptCode }
      }
      const { rows: [existing] } = await client.query(`
        SELECT receipt, serial_hash, receipt_code FROM ballot.ballots
        WHERE election_id = $1 AND (serial_hash = $2 OR receipt = $3)
        ORDER BY (serial_hash = $2) DESC LIMIT 1`, [id, serialHash, receipt])
      if (existing?.serial_hash === serialHash && existing.receipt === receipt) {
        return { status: 200, receipt, receiptCode: existing.receipt_code }
      }
      if (existing?.serial_hash === serialHash) throw new HttpError(409, 'This credential has already been used.')
      requireOpen({ closed_at })
      if (existing) throw new HttpError(409, 'This encrypted ballot has already been received.')
      // No row matches the serial or receipt hash, so retry with a fresh code.
    }
    throw new Error('Could not allocate a unique ballot receipt code.')
  })
  res.status(result.status).json({ receipt: result.receipt, receiptCode: result.receiptCode })
})

api.post('/ballot-receipt', express.urlencoded({ extended: false, limit: '1kb' }), async (req, res) => {
  const { electionId, receipt, view } = req.body ?? {}
  const short = isReceiptCode(receipt)
  if (typeof electionId !== 'string' || (!short && !isHex(receipt, 32))) {
    throw new HttpError(400, 'Enter a valid ballot receipt.')
  }
  // Verify existence without connecting the receipt to a voter account.
  const { rowCount } = await db.pool.query(`
    SELECT 1 FROM ballot.ballots b JOIN ballot.elections e ON e.id = b.election_id
    WHERE e.id = $1 AND COALESCE(e.series_id, e.id) = $2
      AND (CASE WHEN $3 THEN b.receipt_code ELSE b.receipt END) = $4`,
  [electionId, ELECTION.id, short, receipt])
  if (!rowCount) throw new HttpError(404, 'This receipt is no longer available.')
  const pdf = await createReceiptPdf(ELECTION, receipt)
  const disposition = view === 'inline' ? 'inline' : 'attachment'
  res.set('Content-Disposition', disposition + '; filename="votesecure-ballot-receipt.pdf"')
  res.type('application/pdf').send(Buffer.from(pdf.output('arraybuffer')))
})

function requireCurrentRun(req, id) {
  if ((req.body?.electionId ?? ELECTION.id) !== id) {
    throw new HttpError(409, 'This election has been reset. Refresh the page to open the current election.')
  }
}

function requireAdmin(req, _res, next) {
  const token = req.get('Authorization') ?? ''
  if (!safeEqual(token, `Bearer ${ADMIN_KEY}`)) throw new HttpError(401, 'The admin key did not match.')
  next()
}

api.post('/admin/reset', requireAdmin, async (req, res) => {
  if (req.body?.confirmation !== 'RESET' || typeof req.body.electionId !== 'string') {
    throw new HttpError(400, 'Confirm the full reset for the current election.')
  }
  const reset = await db.transaction(async (client) => {
    const { id } = await electionRow(client, 'FOR UPDATE')
    requireCurrentRun(req, id)
    const ballots = await client.query('DELETE FROM ballot.ballots WHERE election_id = $1', [id])
    await client.query('DELETE FROM identity.issuances WHERE election_id = $1', [id])
    // Include account tables from earlier sign-in methods in this dedicated schema.
    const { rows: [accountTables] } = await client.query(`
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename) AS names
      FROM pg_catalog.pg_tables WHERE schemaname = 'mobile_accounts'`)
    await client.query('LOCK TABLE ' + accountTables.names + ' IN ACCESS EXCLUSIVE MODE')
    const { rows: [accounts] } = await client.query('SELECT count(*)::int AS total FROM mobile_accounts.users')
    await client.query('TRUNCATE TABLE ' + accountTables.names)
    const nextId = randomUUID()
    await client.query(`UPDATE ballot.elections SET series_id = $2, id = $3, closed_at = NULL, publication = NULL
      WHERE id = $1`, [id, ELECTION.id, nextId])
    return { electionId: nextId, status: 'open', clearedBallots: ballots.rowCount, clearedAccounts: accounts.total }
  })
  res.json(reset)
})

api.post('/admin/close', requireAdmin, async (req, res) => {
  const publication = await db.transaction(async (client) => {
    const election = await electionRow(client, 'FOR UPDATE')
    const { id } = election
    requireCurrentRun(req, id)
    if (election.closed_at) return election.publication
    const { rows } = await client.query(`
      SELECT receipt, ciphertext FROM ballot.ballots WHERE election_id = $1 ORDER BY sequence`, [id])
    const closedAt = new Date().toISOString()
    const result = await publish(rows, keys, closedAt, { ...ELECTION, id })
    await client.query('UPDATE ballot.elections SET closed_at = $2, publication = $3 WHERE id = $1', [id, closedAt, result])
    return result
  })
  res.json({ snapshot: publication.snapshot })
})

let cachedTree
async function publicationOrThrow() {
  const { publication } = await electionRow(db.pool)
  if (!publication) throw new HttpError(409, 'Polls are open. Results and proofs are published after closing.')
  return publication
}

api.get('/audit', async (_req, res) => {
  const { snapshot, signature } = await publicationOrThrow()
  res.json({ snapshot, signature })
})

api.get('/audit/export', async (_req, res) => {
  res.attachment('votesecure-audit.json').json(await publicationOrThrow())
})

api.get('/audit/receipts/:receipt', async (req, res) => {
  const input = req.params.receipt
  const isShortCode = isReceiptCode(input.toUpperCase())
  if (!isShortCode && !isHex(input.toLowerCase(), 32)) throw new HttpError(400, 'Enter your six-letter receipt code.')
  const receiptCode = isShortCode ? input.toUpperCase() : null
  const { snapshot, leaves } = await publicationOrThrow()
  if (cachedTree?.id !== snapshot.electionId || cachedTree.tree.root !== snapshot.root) {
    const tree = await MerkleTree.build(leaves)
    if (tree.root !== snapshot.root) throw new Error('Published receipt list does not match its root.')
    cachedTree = { id: snapshot.electionId, tree, indexes: new Map(leaves.map((leaf, index) => [leaf, index])) }
  }
  const { indexes, tree } = cachedTree
  let receipt = input.toLowerCase()
  if (receiptCode) {
    const { rows: [ballot] } = await db.pool.query(
      'SELECT receipt FROM ballot.ballots WHERE election_id = $1 AND receipt_code = $2', [snapshot.electionId, receiptCode],
    )
    receipt = ballot?.receipt
  }
  const index = indexes.get(receipt)
  if (index === undefined) throw new HttpError(404, 'This receipt was not found in the published ballot ledger.')
  res.json({ receipt, receiptCode, proof: tree.proof(index) })
})

app.use('/api', api)
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found.')))
app.use((error, _req, res, _next) => {
  if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message })
  console.error('Request failed:', error.code ?? error.message)
  res.status(500).json({ error: 'The request could not be completed. Try again.' })
})

const web = resolve('dist')
if (existsSync(resolve(web, 'index.html'))) app.use(express.static(web))
if (process.env.VERCEL !== '1') {
  await initializeDatabase()
  app.listen(Number(PORT), '127.0.0.1', () => console.log(`VoteSecure PK API listening on http://localhost:${PORT}`))
}

export default app

