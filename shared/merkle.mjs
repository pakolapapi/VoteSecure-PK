import { encode, hex, isHex } from './election.mjs'

const hash = async (value) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
const parent = (left, right) => hash(encode(`votesecure-merkle-node-v1:${left}${right}`))

export class MerkleTree {
  constructor(levels) {
    this.levels = levels
    this.root = levels.at(-1)[0]
  }

  static async build(leaves) {
    if (!leaves.length) return new MerkleTree([[await hash(encode('votesecure-merkle-empty-v1'))]])
    const levels = [leaves]
    while (levels.at(-1).length > 1) {
      const level = levels.at(-1)
      const pending = []
      for (let i = 0; i < level.length; i += 2) {
        pending.push(parent(level[i], level[i + 1] ?? level[i]))
      }
      levels.push(await Promise.all(pending))
    }
    return new MerkleTree(levels)
  }

  proof(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.levels[0].length) throw new RangeError('Invalid leaf index')
    return this.levels.slice(0, -1).map((level) => {
      const sibling = { side: index % 2 ? 'left' : 'right', hash: level[index ^ 1] ?? level[index] }
      index = Math.floor(index / 2)
      return sibling
    })
  }

  static async verify(leaf, proof, root) {
    if (!isHex(leaf, 32) || !isHex(root, 32) || !Array.isArray(proof)) return false
    let current = leaf
    for (const sibling of proof) {
      if (!isHex(sibling?.hash, 32) || !['left', 'right'].includes(sibling.side)) return false
      current = sibling.side === 'left' ? await parent(sibling.hash, current) : await parent(current, sibling.hash)
    }
    return current === root
  }
}

