// 플러그인 API에는 작업 트리 생성이 없어서 orca CLI를 호출한다.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'

// worker에서 그냥 'orca'를 부르면 Windows는 앱 본체(Orca.exe)를 찾아 실행한다. 함께 설치된 CLI를 지정한다.
// 셸을 거치지 않으므로 orca.cmd처럼 프롬프트의 줄바꿈이 망가지지 않는다.
const resources = (process as { resourcesPath?: string }).resourcesPath ?? join(dirname(process.execPath), 'resources')
const ORCA_CLI = join(resources, 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca')

// worker 환경에는 APPDATA가 없는데, CLI는 이 값으로 실행 중인 Orca를 찾는다.
const CLI_ENV = { ...process.env, APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') }

function orcaCli(args: string[]): Promise<any> {
  return new Promise((resolve, reject) =>
    execFile(
      ORCA_CLI,
      [...args, '--json'],
      { env: CLI_ENV, timeout: 110_000, maxBuffer: 8 << 20, windowsHide: true },
      (err, out, errText) => {
        let reply: any
        try {
          reply = JSON.parse(out)
        } catch {}
        if (reply?.ok) return resolve(reply.result)
        reject(new Error(reply?.error?.message ?? (errText || err?.message || 'orca 실행 실패').trim()))
      }
    )
  )
}

const IMAGE_DIR = join(homedir(), '.orca-issues', 'images')
const MAX_IMAGE_BYTES = 10 << 20
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

// 파일 이름은 worker가 만든 형식만 받는다. 이미지 폴더 밖의 파일을 가리킬 수 없다.
export function imagePath(name: string) {
  if (!/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(name)) throw new Error('잘못된 이미지 이름입니다.')
  return join(IMAGE_DIR, name)
}

export function imageExtension(type: string) {
  const extension = IMAGE_TYPES[type]
  if (!extension) throw new Error('PNG, JPEG, GIF, WebP 이미지만 붙여넣을 수 있습니다.')
  return extension
}

export function decodeChunk(data: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('잘못된 이미지 데이터입니다.')
  return Buffer.from(data, 'base64')
}

// 3의 배수여야 조각별 base64를 이어 붙여도 올바른 값이 된다.
const READ_CHUNK_BYTES = 30_000

export function promptWithImages(prompt: string, images: string[]) {
  if (images.length === 0) return prompt
  return `${prompt}\n\n첨부 이미지:\n${images.map((name, i) => `- [Image #${i + 1}] ${imagePath(name)}`).join('\n')}`
}

export function runArgs(input: {
  repoId: string
  worktreeId?: string
  agent: string
  name: string
  prompt: string
}) {
  if (input.worktreeId) {
    return [
      'agent',
      'launch',
      '--agent',
      input.agent,
      '--worktree',
      `id:${input.worktreeId}`,
      '--prompt',
      input.prompt,
      '--focus'
    ]
  }
  return [
    'worktree',
    'create',
    '--repo',
    `id:${input.repoId}`,
    '--name',
    input.name,
    '--agent',
    input.agent,
    '--prompt',
    input.prompt,
    '--no-parent',
    '--activate'
  ]
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('repos.list', async () => {
    const { repos } = await orcaCli(['repo', 'list'])
    return repos
      .filter((r: { kind: string }) => r.kind === 'git')
      .map((r: { id: string; displayName: string }) => ({ id: r.id, name: r.displayName }))
  })

  orca.panels.handle('worktrees.list', async ({ repoId }) => {
    const { worktrees } = await orcaCli(['worktree', 'list', '--repo', `id:${repoId}`])
    return worktrees
      .filter((w: { isArchived?: boolean }) => !w.isArchived)
      .map((w: { id: string; displayName: string; repoId: string }) => ({
        id: w.id,
        name: w.displayName,
        repoId: w.repoId
      }))
  })

  orca.panels.handle('issue.run', async ({ images, ...input }) => {
    await orcaCli(runArgs({ ...input, prompt: promptWithImages(input.prompt, images) }))
    return { ok: true as const }
  })

  orca.panels.handle('image.start', async ({ type }) => {
    const name = `${randomUUID()}.${imageExtension(type)}`
    await mkdir(IMAGE_DIR, { recursive: true })
    await writeFile(imagePath(name), '')
    return { name }
  })

  orca.panels.handle('image.append', async ({ name, data }) => {
    const path = imagePath(name)
    await appendFile(path, decodeChunk(data))
    if ((await stat(path)).size > MAX_IMAGE_BYTES) {
      await rm(path)
      throw new Error('이미지는 10MB까지 붙여넣을 수 있습니다.')
    }
    return { ok: true as const }
  })

  orca.panels.handle('image.read', async ({ name, offset }) => {
    const type = Object.keys(IMAGE_TYPES).find((t) => name.endsWith(`.${IMAGE_TYPES[t]}`)) as string
    const bytes = await readFile(imagePath(name))
    return {
      type,
      data: bytes.subarray(offset, offset + READ_CHUNK_BYTES).toString('base64'),
      size: bytes.length
    }
  })
}
