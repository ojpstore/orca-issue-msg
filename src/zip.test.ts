import { assert, test } from 'orca/testing'
import { readZip, writeZip } from './zip'

test('zip으로 묶은 파일을 그대로 다시 꺼낸다', () => {
  const image = Buffer.from([0, 1, 2, 255, 254])
  const entries = readZip(writeZip([
    { name: 'issues.json', data: Buffer.from('{"한글":"가나다"}'.repeat(50)) },
    { name: 'images/a.png', data: image }
  ]))
  assert.deepEqual([...entries.keys()], ['issues.json', 'images/a.png'])
  assert.equal(entries.get('issues.json')!().toString('utf8'), '{"한글":"가나다"}'.repeat(50))
  assert.deepEqual([...entries.get('images/a.png')!()], [...image])
})

test('zip이 아닌 파일은 거부한다', () => {
  assert.throws(() => readZip(Buffer.from('not a zip file at all, just text')))
})
