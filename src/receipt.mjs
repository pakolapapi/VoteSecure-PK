import { isHex, isReceiptCode } from '../shared/election.mjs'

export async function createReceiptPdf(election, receipt) {
  const short = isReceiptCode(receipt)
  if (!short && !isHex(receipt, 32)) throw new Error('The ballot receipt is invalid.')
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: [105, 148], compress: true })
  pdf.setProperties({
    title: 'VoteSecure PK Ballot Receipt',
    subject: election.name,
    keywords: 'VoteSecureReceiptV1:' + receipt,
  })

  const left = 10
  const width = 85
  const ink = '#13271e'
  const muted = '#40574b'
  const green = '#106044'
  const mint = '#a2f4ca'

  pdf.setFillColor('#f1f7f2')
  pdf.rect(0, 0, 105, 148, 'F')
  pdf.setFillColor('#ffffff')
  pdf.setDrawColor('#b9cdc0')
  pdf.roundedRect(5, 5, 95, 138, 4, 4, 'FD')

  pdf.setFillColor('#103c2d')
  pdf.roundedRect(5, 5, 95, 42, 4, 4, 'F')
  pdf.rect(5, 40, 95, 7, 'F')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(11)
  pdf.setTextColor(mint)
  pdf.text('VoteSecure PK', left, 16)
  pdf.setFont('times', 'bold')
  pdf.setFontSize(26)
  pdf.setTextColor('#ffffff')
  pdf.text('Ballot receipt', left, 29)

  pdf.setFillColor('#d8f5e5')
  pdf.roundedRect(left, 34, 31, 8, 4, 4, 'F')
  pdf.setTextColor(green)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(9)
  pdf.text('Ballot recorded', left + 15.5, 39.25, { align: 'center' })

  pdf.setTextColor(ink)
  pdf.setFontSize(12)
  pdf.text(election.name, left, 57, { maxWidth: width })
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.setTextColor(muted)
  pdf.text('Constituency ' + election.seat.replace('-DEMO-', '-'), left, 65)

  pdf.setDrawColor('#a1b8aa')
  pdf.setLineDashPattern([1.5, 1], 0)
  pdf.line(5, 73, 100, 73)
  pdf.setLineDashPattern([], 0)
  pdf.setFillColor('#f1f7f2')
  pdf.circle(5, 73, 2.1, 'F')
  pdf.circle(100, 73, 2.1, 'F')

  pdf.setFillColor('#e9f5ee')
  pdf.roundedRect(left, 81, width, 25, 3, 3, 'F')
  pdf.setTextColor(green)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(9)
  pdf.text('Receipt code', left + 4, 88)
  pdf.setFont('courier', 'bold')
  pdf.setTextColor(ink)
  pdf.setFontSize(short ? 25 : 10)
  if (short) {
    pdf.text(receipt, left + 4, 100, { charSpace: 2 })
  } else {
    pdf.text([receipt.slice(0, 32), receipt.slice(32)], left + 4, 94, { lineHeightFactor: 1.45 })
  }

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(10)
  pdf.text('Check your receipt after polls close', left, 116)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.setTextColor(muted)
  pdf.text('Open Results & audit and upload this PDF to check that your encrypted ballot appears in the published ledger.', left, 122, { maxWidth: width })
  pdf.setFontSize(8)
  pdf.setTextColor(green)
  pdf.text('Academic election portal', left, 136)

  return pdf
}

export async function readReceiptFile(file) {
  if (file.size > 128 * 1024) throw new Error('Choose the original VoteSecure receipt file.')
  const content = await file.text()
  if (!content.startsWith('%PDF-')) {
    const receipt = content.trim()
    if (isReceiptCode(receipt.toUpperCase())) return receipt.toUpperCase()
    if (isHex(receipt.toLowerCase(), 32)) return receipt.toLowerCase()
  } else {
    // Read only the receipt marker that VoteSecure writes into its PDF metadata.
    const markers = [...content.matchAll(/\/Keywords\s*\(VoteSecureReceiptV1:([A-Z]{6}|[0-9a-f]{64})\)/g)]
    if (markers.length === 1) return markers[0][1]
  }
  throw new Error('Choose a VoteSecure receipt PDF or text file, or enter the receipt code.')
}
