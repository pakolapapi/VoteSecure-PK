import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import pg from 'pg'
import { test } from 'node:test'
import { additionalDemoVoters, demoVoters } from '../shared/election.mjs'
import { readReceiptFile } from '../src/receipt.mjs'
import { MerkleTree } from '../shared/merkle.mjs'
import { encryptedBallot, expectedReceipt, finalizeCredential, prepareCredential, verifyAudit } from '../src/client.mjs'

const base = `http://127.0.0.1:${process.env.PORT ?? 3000}/api`
async function request(route, expectedStatus, body, adminKey, account) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(account ? { Cookie: account.cookie } : {}),
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(account?.cnic ? { ...body, accountCnic: account.cnic } : body),
  })
  const data = await response.json()
  assert.ok([expectedStatus].flat().includes(response.status), `Expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(data)}`)
  return { status: response.status, ...data }
}

async function createAccountFixtures() {
  const key = Buffer.from(process.env.ACCOUNT_DATA_KEY ?? '', 'base64url')
  assert.equal(key.length, 32, 'Set ACCOUNT_DATA_KEY for the isolated integration server.')
  assert.ok(process.env.DATABASE_URL, 'Set a disposable DATABASE_URL.')
  const indexKey = createHmac('sha256', key).update('account-index-v1').digest()
  const digest = (value) => createHmac('sha256', indexKey).update(value).digest('hex')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const accounts = []
    for (const cnic of ['9999999999998', '9999999999999']) {
      const token = randomBytes(32).toString('base64url')
      const cnicHash = digest('cnic:' + cnic)
      await pool.query('INSERT INTO mobile_accounts.users (cnic_hash, mobile_hash, encrypted_name) VALUES ($1, $2, $3)',
        [cnicHash, digest('fixture-mobile:' + cnic), Buffer.alloc(28)])
      await pool.query('INSERT INTO mobile_accounts.sessions (token_hash, cnic_hash, expires_at) VALUES ($1, $2, $3)',
        [createHash('sha256').update(token).digest('hex'), cnicHash, new Date(Date.now() + 15 * 60 * 1000)])
      accounts.push({ cnic, workspace: digest('ballot-workspace:' + cnicHash), cookie: 'votesecure_email_session=' + token })
    }
    return accounts
  } finally {
    await pool.end()
  }
}

test('fresh election: mock KYC, blind issuance, replay, close, and public receipt', async () => {
  const election = await request('/election', 200)
  assert.equal(election.status, 'open', 'Use a fresh demo database for this test.')
  const [account, nextAccount] = await createAccountFixtures()
  const identity = (route, status, body, chosen = account) => request(route, status, body, undefined, chosen)
  const credentials = { cnic: demoVoters[0].cnic, pin: demoVoters[0].pin }
  await request('/identity/verify', 401, credentials)
  await identity('/identity/verify', 403, credentials, { ...account, cnic: nextAccount.cnic })
  const { blinded: unauthenticatedBlinded } = await prepareCredential(election)
  await request('/identity/credentials', 401, { ...credentials, blinded: unauthenticatedBlinded })
  await identity('/identity/credentials', 403, { ...credentials, blinded: unauthenticatedBlinded }, { ...account, cnic: nextAccount.cnic })
  for (const voter of demoVoters.slice(3)) {
    const { blinded } = await prepareCredential(election)
    await identity('/identity/credentials', 403, { cnic: voter.cnic, pin: voter.pin, blinded })
  }
  const { cnic, pin } = demoVoters[0]
  const preview = await identity('/identity/verify', 200, { cnic, pin })
  assert.equal(preview.problem, null)
  assert.equal(preview.checks.length, 7)
  assert.ok(preview.checks.every(({ passed }) => passed))
  const underage = await identity('/identity/verify', 200, { cnic: demoVoters[3].cnic, pin: demoVoters[3].pin })
  assert.equal(underage.checks.find(({ label }) => label === 'Minimum age').passed, false)
  await identity('/identity/verify', 401, { cnic, pin: '000000' })
  const voter = demoVoters[0]
  const pending = await prepareCredential(election)
  const otherRequest = await prepareCredential(election)
  const body = { cnic: voter.cnic, pin: voter.pin, blinded: pending.blinded }
  const otherBody = { ...body, blinded: otherRequest.blinded }
  await identity('/identity/credentials', 401, { ...body, pin: '000000' })
  const issues = await Promise.all([body, otherBody].map((value) => identity('/identity/credentials', [200, 409], value)))
  assert.deepEqual(issues.map(({ status }) => status).sort(), [200, 409])
  const issue = issues.findIndex(({ status }) => status === 200)
  const retry = await identity('/identity/credentials', 200, [body, otherBody][issue])
  assert.equal(retry.signature, issues[issue].signature)
  const credential = await finalizeCredential(election, [pending, otherRequest][issue], retry.signature)
  const ballot = await encryptedBallot(election, 'cedar', credential)
  const otherBallot = await encryptedBallot(election, 'river', credential)
  await request('/ballots', 400, { ...ballot, seat: 'LHR-DEMO-01' })
  await request('/ballots', 403, { ...ballot, serial: '00'.repeat(32) })
  const candidates = [ballot, otherBallot]
  const results = await Promise.all(candidates.map((entry) => request('/ballots', [201, 409], entry)))
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409])
  const index = results.findIndex(({ status }) => status === 201)
  const { receipt, receiptCode } = results[index]
  assert.match(receiptCode, /^[A-Z]{6}$/)
  assert.equal(receipt, await expectedReceipt(election, candidates[index].ciphertext))
  const downloadReceipt = (code, view) => fetch(base + '/ballot-receipt', {
    method: 'POST',
    body: new URLSearchParams({ electionId: election.id, receipt: code, view }),
  })
  for (const [code, view, disposition] of [[receiptCode, '', 'attachment'], [receipt, 'inline', 'inline']]) {
    const pdf = await downloadReceipt(code, view)
    assert.equal(pdf.status, 200)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.equal(pdf.headers.get('content-disposition'), disposition + '; filename="votesecure-ballot-receipt.pdf"')
    assert.equal(await readReceiptFile(await pdf.blob()), code)
  }
  assert.equal((await downloadReceipt('INVALID', '')).status, 400)
  const retryReceipt = await request('/ballots', 200, candidates[index])
  assert.equal(retryReceipt.receipt, receipt)
  assert.equal(retryReceipt.receiptCode, receiptCode)
  const nextVoter = additionalDemoVoters.find(({ cnic }) => cnic.endsWith('10'))
  const nextPending = await prepareCredential(election)
  const nextIdentity = { cnic: nextVoter.cnic, pin: nextVoter.pin, blinded: nextPending.blinded }
  const requestFor = (workspace, blinded = nextPending.blinded) => ({ workspace, blinded })
  const issueFor = (account, status, body) => request('/identity/credentials', status, body, undefined, { cookie: account.cookie })
  await request('/identity/credentials', 401, requestFor(nextAccount.workspace))
  await issueFor(account, 409, requestFor(nextAccount.workspace))
  await issueFor(account, 409, requestFor(account.workspace))
  const duplicate = await prepareCredential(election)
  const requests = [nextPending, duplicate]
  const accountIssues = await Promise.all(requests.map(({ blinded }) => issueFor(nextAccount, [200, 409], requestFor(nextAccount.workspace, blinded))))
  assert.deepEqual(accountIssues.map(({ status }) => status).sort(), [200, 409])
  const winningRequest = accountIssues.findIndex(({ status }) => status === 200)
  const { signature } = await issueFor(nextAccount, 200, requestFor(nextAccount.workspace, requests[winningRequest].blinded))
  assert.equal(signature, accountIssues[winningRequest].signature)
  await identity('/identity/credentials', 409, nextIdentity, nextAccount)
  const nextCredential = await finalizeCredential(election, requests[winningRequest], signature)
  const nextBallot = await encryptedBallot(election, 'harbor', nextCredential)
  const nextSubmission = await request('/ballots', 201, nextBallot)
  assert.notEqual(nextSubmission.receipt, receipt)
  assert.match(nextSubmission.receiptCode, /^[A-Z]{6}$/)
  assert.notEqual(nextSubmission.receiptCode, receiptCode)
  await request('/audit/receipts/' + receiptCode, 409)
  await request('/audit', 409)
  await request('/admin/close', 401, {}, 'wrong-key')
  await request('/admin/close', 200, {}, process.env.ADMIN_KEY)
  await issueFor(nextAccount, 409, requestFor(nextAccount.workspace))
  assert.equal((await request('/ballots', 200, candidates[index])).receipt, receipt)
  const audit = await request('/audit', 200)
  assert.equal(audit.snapshot.ballots, 2)
  assert.equal(audit.snapshot.results[2].votes, 1)
  assert.equal(audit.snapshot.results[index].votes, 1)
  assert.equal(await verifyAudit(election, audit), true)
  const lookup = await request('/audit/receipts/' + receiptCode.toLowerCase(), 200)
  assert.equal(lookup.receiptCode, receiptCode)
  assert.equal(lookup.receipt, receipt)
  assert.equal(await MerkleTree.verify(lookup.receipt, lookup.proof, audit.snapshot.root), true)
  const result = await request('/audit/receipts/' + receipt, 200)
  assert.equal(await MerkleTree.verify(receipt, result.proof, audit.snapshot.root), true)
  await request('/audit/receipts/' + '00'.repeat(32), 404)
  const reset = { electionId: election.id, confirmation: 'RESET' }
  await request('/admin/reset', 401, reset, 'wrong-key')
  await request('/admin/reset', 400, { electionId: election.id }, process.env.ADMIN_KEY)
  const fresh = await request('/admin/reset', 200, reset, process.env.ADMIN_KEY)
  assert.equal((await downloadReceipt(receiptCode, '')).status, 404)
  assert.equal(fresh.clearedBallots, 2)
  assert.equal(fresh.clearedAccounts, 2)
  assert.notEqual(fresh.electionId, election.id)
  assert.equal((await request('/election', 200)).id, fresh.electionId)
  await request('/admin/reset', 409, reset, process.env.ADMIN_KEY)
  await request('/admin/close', 409, { electionId: election.id }, process.env.ADMIN_KEY)
  await request('/audit', 409)
  await request('/audit/receipts/' + receipt, 409)
  await request('/ballots', 403, ballot)
  assert.equal((await request('/voter-account', 200, undefined, undefined, account)).account, null)
  const [registeredAgain] = await createAccountFixtures()
  const newElection = await request('/election', 200)
  const freshPending = await prepareCredential(newElection)
  const issued = await issueFor(registeredAgain, 200, { ...requestFor(registeredAgain.workspace, freshPending.blinded), electionId: fresh.electionId })
  const freshCredential = await finalizeCredential(newElection, freshPending, issued.signature)
  await request('/ballots', 201, await encryptedBallot(newElection, 'cedar', freshCredential))
  await request('/admin/close', 200, { electionId: fresh.electionId }, process.env.ADMIN_KEY)
  const newAudit = await request('/audit', 200)
  assert.equal(newAudit.snapshot.ballots, 1)
  assert.equal(await verifyAudit(newElection, newAudit), true)
  await request('/audit/receipts/' + receipt, 404)
})

