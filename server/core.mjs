import { createHash, createPrivateKey, privateDecrypt, sign, timingSafeEqual } from 'node:crypto'
import { auditPayload, ELECTION, leafPayload } from '../shared/election.mjs'
import { MerkleTree } from '../shared/merkle.mjs'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const hashPin = (cnic, pin) => sha256(`votesecure-demo-pin-v1:${cnic}:${pin}`)

export function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function eligibilityChecks(voter, cutoff, seat) {
  // Dates arrive as YYYY-MM-DD from PostgreSQL.
  const years = Number(cutoff.slice(0, 4)) - Number(voter.dob.slice(0, 4))
  const age = years - Number(cutoff.slice(5) < voter.dob.slice(5))
  return [
    { label: 'Citizenship', passed: voter.citizen },
    { label: 'CNIC issuance', passed: voter.cnic_issued },
    { label: 'Minimum age', passed: age >= 18 },
    { label: 'Electoral roll', passed: voter.registered },
    { label: 'Residence', passed: voter.resident },
    { label: 'Legal eligibility', passed: voter.legally_eligible },
    { label: 'Constituency', passed: voter.seat === seat },
  ]
}

export function eligibilityError(voter, cutoff, seat) {
  const [citizen, cnic, age, roll, residence, legal, constituency] = eligibilityChecks(voter, cutoff, seat)
  if (!(citizen.passed && cnic.passed)) return 'Mock NADRA could not verify citizenship and CNIC issuance.'
  if (!age.passed) return 'The voter is under 18 on the eligibility cutoff date.'
  if (!roll.passed) return 'The voter has no active electoral-roll entry.'
  if (!legal.passed || !residence.passed) return 'The voter does not meet the residence or legal eligibility requirements.'
  if (!constituency.passed) return 'The voter is registered in a different constituency.'
  return null
}

export async function publish(ballots, keys, closedAt, election = ELECTION) {
  const results = election.candidates.map(({ id }) => ({ id, votes: 0 }))
  const candidates = new Map(results.map((entry) => [entry.id, entry]))
  const privateKey = createPrivateKey({ key: keys.ballot.privateKey, format: 'jwk' })
  let invalid = 0
  for (const ballot of ballots) {
    if (sha256(leafPayload(election.id, election.seat, ballot.ciphertext)) !== ballot.receipt) {
      throw new Error('The stored ciphertext does not match its receipt.')
    }
    let payload
    try {
      const plaintext = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(ballot.ciphertext, 'hex'))
      payload = JSON.parse(plaintext.toString('utf8'))
    } catch {
      invalid += 1
      continue
    }
    const [, id, seat, choice] = Array.isArray(payload) ? payload : []
    if (Array.isArray(payload) && payload.length === 4 && payload[0] === 'votesecure-ballot-v1' && id === election.id && seat === election.seat && candidates.has(choice)) {
      candidates.get(choice).votes += 1
    } else {
      invalid += 1
    }
  }
  const leaves = ballots.map(({ receipt }) => receipt)
  const { root } = await MerkleTree.build(leaves)
  const snapshot = { electionId: election.id, seat: election.seat, closedAt, root, ballots: ballots.length, invalid, results }
  const signature = sign('sha256', auditPayload(snapshot), {
    key: createPrivateKey({ key: keys.audit.privateKey, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('hex')
  return { snapshot, signature, leaves }
}

