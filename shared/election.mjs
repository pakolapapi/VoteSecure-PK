export const ELECTION = Object.freeze({
  id: 'karachi-demo-2026',
  name: 'Karachi Constituency Election',
  seat: 'KHI-DEMO-01',
  cutoff: '2026-11-15',
  candidates: [
    { id: 'cedar', name: 'Sara Khan', group: 'Cedar Group', mark: 'C', symbol: 'Cedar tree' },
    { id: 'river', name: 'Hamza Ali', group: 'River Group', mark: 'R', symbol: 'Sailboat' },
    { id: 'harbor', name: 'Mariam Ahmed', group: 'Harbor Group', mark: 'H', symbol: 'Anchor' },
  ],
})

export const demoVoters = [
  { label: 'Eligible voter A', cnic: '0000000000001', pin: '101001', dob: '2000-04-18', seat: ELECTION.seat },
  { label: 'Eligible voter B', cnic: '0000000000002', pin: '101002', dob: '2004-09-23', seat: ELECTION.seat },
  { label: 'Eligible voter C', cnic: '0000000000003', pin: '101003', dob: '1999-01-27', seat: ELECTION.seat },
  { label: 'Under 18', cnic: '0000000000004', pin: '101004', dob: '2010-02-11', seat: ELECTION.seat },
  { label: 'Different constituency', cnic: '0000000000005', pin: '101005', dob: '1998-02-11', seat: 'LHR-DEMO-01' },
  { label: 'Missing roll entry', cnic: '0000000000006', pin: '101006', dob: '1998-02-11', seat: ELECTION.seat, registered: false },
]

export const additionalDemoVoters = Array.from({ length: 21 }, (_, index) => {
  const number = index + 7
  return {
    label: `Eligible voter ${index + 4}`,
    cnic: String(number).padStart(13, '0'),
    pin: String(101000 + number),
    dob: '2000-04-18',
    seat: ELECTION.seat,
  }
})

export const isDemoCnic = (value) => typeof value === 'string' && /^0{11}([0-9][1-9]|[1-9]0)$/.test(value)

export const encode = (value) => new TextEncoder().encode(value)
export const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
export const fromHex = (value) => Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
export const isReceiptCode = (value) => typeof value === 'string' && /^[A-Z]{6}$/.test(value)
export const isHex = (value, bytes) => typeof value === 'string' && value.length === bytes * 2 && /^[a-f0-9]+$/.test(value)

export function credentialMessage(electionId, seat, serial) {
  return encode(JSON.stringify(['votesecure-credential-v1', electionId, seat, serial]))
}

export function preparedCredentialMessage(electionId, seat, serial, prefix) {
  const payload = credentialMessage(electionId, seat, serial)
  const message = new Uint8Array(32 + payload.length)
  message.set(fromHex(prefix))
  message.set(payload, 32)
  return message
}

export const leafPayload = (electionId, seat, ciphertext) => encode(JSON.stringify(['votesecure-ballot-v1', electionId, seat, ciphertext]))

export function auditPayload(snapshot) {
  return encode(JSON.stringify([
    'votesecure-audit-v1', snapshot.electionId, snapshot.seat, snapshot.closedAt, snapshot.root,
    snapshot.ballots, snapshot.invalid, snapshot.results.map(({ id, votes }) => [id, votes]),
  ]))
}

