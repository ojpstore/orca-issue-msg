import { assert, test } from 'orca/testing'
import { decodeChunk, imageExtension, imagePath, promptWithImages, runArgs } from './worker'

test('프롬프트는 줄바꿈 그대로 한 인자로 넘어간다', () => {
  const args = runArgs({ repoId: 'r1', agent: 'claude', name: 'ENG-1', prompt: 'a\n"b" & c' })
  assert.equal(args[args.indexOf('--prompt') + 1], 'a\n"b" & c')
  assert.equal(args[args.indexOf('--repo') + 1], 'id:r1')
  assert.ok(args.includes('--no-parent'))
})

test('worktreeId가 있으면 새로 만들지 않고 그 트리에서 에이전트를 실행한다', () => {
  const args = runArgs({ repoId: 'r1', worktreeId: 'r1::D:/a', agent: 'codex', name: 'ENG-1', prompt: 'p' })
  assert.deepEqual(args.slice(0, 2), ['agent', 'launch'])
  assert.equal(args[args.indexOf('--worktree') + 1], 'id:r1::D:/a')
})

const NAME = '123e4567-e89b-12d3-a456-426614174000.png'

test('이미지 폴더 밖을 가리키는 이름은 거부한다', () => {
  assert.throws(() => imagePath('../../secret.png'))
  assert.throws(() => imagePath('C:\\Windows\\win.ini'))
  assert.ok(imagePath(NAME).endsWith(NAME))
})

test('허용하지 않는 이미지 형식과 깨진 조각은 거부한다', () => {
  assert.equal(imageExtension('image/jpeg'), 'jpg')
  assert.throws(() => imageExtension('image/svg+xml'))
  assert.throws(() => imageExtension('text/html'))
  assert.throws(() => decodeChunk('not base64!'))
})

test('4의 배수로 자른 base64 조각을 이어 붙이면 원본이 된다', () => {
  const original = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
  const base64 = original.toString('base64')
  const parts = []
  for (let i = 0; i < base64.length; i += 400) parts.push(decodeChunk(base64.slice(i, i + 400)))
  assert.deepEqual(Buffer.concat(parts), original)
})

test('이미지가 있으면 프롬프트 끝에 절대 경로를 붙인다', () => {
  assert.equal(promptWithImages('p', []), 'p')
  const prompt = promptWithImages('p', [NAME])
  assert.ok(prompt.startsWith('p\n\n첨부 이미지:\n- '))
  assert.ok(prompt.includes(`- [Image #1] ${imagePath(NAME)}`))
})
