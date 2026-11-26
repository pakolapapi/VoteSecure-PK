import assert from 'node:assert/strict'
import { constants, createPublicKey, generateKeyPairSync, publicEncrypt, verify } from 'node:crypto'
import { test } from 'node:test'
import { auditPayload, demoVoters, ELECTION, leafPayload } from '../shared/election.mjs'
import { MerkleTree } from '../shared/merkle.mjs'
import { eligibilityError, publish, sha256 } from '../server/core.mjs'

test('eligibility at the age boundary and mock electoral-roll checks', () => {
  const eligible = { citizen: true, cnic_issued: true, resident: true, legally_eligible: true, registered: true, seat: ELECTION.seat, dob: '2008-11-15' }
  const reason = (fields) => eligibilityError({ ...eligible, ...fields }, ELECTION.cutoff, ELECTION.seat)
  assert.equal(reason({}), null)
  assert.match(reason({ dob: '2008-11-16' }), /under 18/)
  assert.match(reason({ cnic_issued: false }), /NADRA/)
  assert.match(reason({ citizen: false }), /NADRA/)
  assert.match(reason({ registered: false }), /electoral-roll/)
  assert.match(reason({ resident: false }), /residence/)
  assert.match(reason({ legally_eligible: false }), /legal/)
  assert.match(reason({ seat: demoVoters[4].seat }), /different constituency/)
})

test('Merkle receipts handle odd, single, and empty trees and reject tampering', async () => {
  const leaves = ['one', 'two', 'three', 'four', 'five'].map(sha256)
  const tree = await MerkleTree.build(leaves)
  for (const [index, leaf] of leaves.entries()) {
    assert.equal(await MerkleTree.verify(leaf, tree.proof(index), tree.root), true)
    assert.equal(await MerkleTree.verify(sha256('altered'), tree.proof(index), tree.root), false)
  }
  assert.equal(await MerkleTree.verify(leaves[0], [], (await MerkleTree.build([leaves[0]])).root), true)
  assert.notEqual((await MerkleTree.build([])).root, tree.root)
  assert.throws(() => tree.proof(leaves.length), RangeError)
})

test('tally counts encrypted choices, rejects invalid choices, and binds the signed snapshot', async () => {
  const ballot = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const audit = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keys = {
    ballot: { privateKey: ballot.privateKey.export({ format: 'jwk' }) },
    audit: { privateKey: audit.privateKey.export({ format: 'jwk' }) },
  }
  function row(choice) {
    const message = Buffer.from(JSON.stringify(['votesecure-ballot-v1', ELECTION.id, ELECTION.seat, choice]))
    const ciphertext = publicEncrypt({ key: ballot.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, message).toString('hex')
    return { ciphertext, receipt: sha256(leafPayload(ELECTION.id, ELECTION.seat, ciphertext)) }
  }
  const rows = [row('cedar'), row('river'), row('cedar'), row('not-on-ballot')]
  assert.notEqual(rows[0].ciphertext, rows[2].ciphertext)
  const data = await publish(rows, keys, '2026-11-15T12:00:00.000Z')
  const { snapshot, leaves, signature } = data
  assert.deepEqual(snapshot.results.map(({ votes }) => votes), [2, 1, 0])
  assert.equal(snapshot.invalid, 1)
  assert.equal((await MerkleTree.build(leaves)).root, snapshot.root)

  const verifySignature = (value) => verify('sha256', auditPayload(value),
    { key: createPublicKey({ key: audit.publicKey.export({ format: 'jwk' }), format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'hex'))
  assert.equal(verifySignature(snapshot), true)
  assert.equal(verifySignature({ ...snapshot, invalid: 0 }), false)
  await assert.rejects(publish([{ ...rows[0], ciphertext: rows[1].ciphertext }], keys, snapshot.closedAt), /does not match/)
})

