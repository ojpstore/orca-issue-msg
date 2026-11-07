// 백업용 최소 zip 읽기/쓰기. 외부 압축 명령이나 패키지에 기대지 않으려고 node:zlib만 쓴다.
// ponytail: zip64(4GB 초과)와 암호화는 지원하지 않는다. 필요하면 라이브러리로 바꾼다.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer) {
  let c = 0xffffffff
  for (const b of buf) c = TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const MAX_ENTRY_BYTES = 256 << 20

// .json은 줄이고, 이미 압축된 이미지는 그대로 담는다.
export function writeZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of files) {
    const method = name.endsWith('.json') ? 8 : 0
    const body = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // 파일명 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(method, 10)
    head.writeUInt16LE(0x21, 14)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(body.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(nameBytes.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(head, nameBytes)
    parts.push(local, nameBytes, body)
    offset += 30 + nameBytes.length + body.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, centralBytes, end])
}

// 이름 → 내용을 꺼내는 함수. 내용은 필요할 때만 푼다.
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('zip 파일이 아닙니다.')
  const entries = new Map<string, () => Buffer>()
  let p = buf.readUInt32LE(end + 16)
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 파일이 손상되었습니다.')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLength = buf.readUInt16LE(p + 28)
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength)
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const body = buf.subarray(start, start + size)
      if (method === 0) return body
      if (method === 8) return inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES })
      throw new Error('지원하지 않는 zip 압축 방식입니다.')
    })
    p += 46 + nameLength + skip
  }
  return entries
}
