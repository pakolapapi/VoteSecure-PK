import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { auditPayload, isHex } from '../shared/election.mjs'
import { MerkleTree } from '../shared/merkle.mjs'

const [exportFile, publicKeyFile] = process.argv.slice(2)
if (!exportFile || !publicKeyFile) {
  console.error('Usage: npm run audit -- votesecure-audit.json audit-public.jwk.json')
  process.exit(2)
}

try {
  const [publication, jwk] = await Promise.all([exportFile, publicKeyFile].map(async (file) => JSON.parse(await readFile(file, 'utf8'))))
  const { snapshot, signature, leaves } = publication
  const counts = [snapshot.ballots, snapshot.invalid, ...snapshot.results.map(({ votes }) => votes)]
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    counts.slice(1).reduce((sum, count) => sum + count, 0) !== snapshot.ballots ||
    !Array.isArray(leaves) || leaves.length !== snapshot.ballots ||
    new Set(leaves).size !== leaves.length || !leaves.every((leaf) => isHex(leaf, 32)) ||
    !isHex(signature, 64)) throw new Error('The publication is malformed.')
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  if (!verify('sha256', auditPayload(snapshot), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'hex'))) {
    throw new Error('The publication signature did not match the supplied audit key.')
  }
  const { root } = await MerkleTree.build(leaves)
  if (root !== snapshot.root) throw new Error('The receipt ledger did not match the signed Merkle root.')
  console.log(`Verified signed publication and receipt ledger for ${snapshot.electionId} (${snapshot.ballots} ballots).`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

