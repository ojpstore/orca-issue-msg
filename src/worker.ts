// 플러그인 API에는 작업 트리 생성이 없어서 orca CLI를 호출한다.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { buildBackup, handoffText, RESULT_MAX, type Project } from './logic'

// worker에서 그냥 'orca'를 부르면 Windows는 앱 본체(Orca.exe)를 찾아 실행한다. 함께 설치된 CLI를 지정한다.
// 셸을 거치지 않으므로 orca.cmd처럼 프롬프트의 줄바꿈이 망가지지 않는다.
const resources = (process as { resourcesPath?: string }).resourcesPath ?? join(dirname(process.execPath), 'resources')
const ORCA_CLI = join(resources, 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca')

// worker 환경에는 APPDATA가 없는데, CLI는 이 값으로 실행 중인 Orca를 찾는다.
const CLI_ENV = { ...process.env, APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') }

// Orca가 에이전트의 마지막 답변을 남기는 파일에서 해당 pane의 답변을 읽는다. 기록이 늦을 수 있어 잠깐 기다리며 재시도한다.
const STATUS_FILE = join(CLI_ENV.APPDATA, 'orca', 'agent-hooks', 'last-status.json')
async function lastAnswer(paneKey: string): Promise<string | undefined> {
  let text: string | undefined
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 300 : 500))
    try {
      const entry = JSON.parse(await readFile(STATUS_FILE, 'utf8')).entries?.[paneKey]
      text = entry?.payload?.lastAssistantMessage || text
      if (text && entry.hookEventName !== 'SubagentStop') break
    } catch {}
  }
  return text?.slice(0, RESULT_MAX)
}

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
const BACKUP_DIR = join(homedir(), '.orca-issues', 'backups')
const BACKUP_KEEP = 10
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
  // 에이전트가 끝나면 작업 트리 id를 남긴다. 이슈 상태는 패널이 이 목록을 보고 바꾼다(저장은 패널만 한다).
  orca.events.on('agent.status.changed', async (e) => {
    if (!e.workspaceId) return
    // 한 작업 트리에서 에이전트가 여러 개 돌 수 있어서, 에이전트(pane)별로 working을 추적한다.
    const pane = e.paneKey
    const working: string[] = (await orca.storage.get('working')) ?? []
    if (e.state === 'working') {
      if (!working.includes(pane)) await orca.storage.set('working', [...working, pane])
      return
    }
    // 시작 직후에도 done이 한 번 오므로, working을 거친 뒤의 done만 완료로 본다.
    if (e.state !== 'done' || !working.includes(pane)) return
    await orca.storage.set('working', working.filter((p) => p !== pane))
    // 종료 한 번에 한 줄씩 쌓는다. 같은 트리를 쓰는 이슈를 한꺼번에 완료하지 않기 위해서다.
    // 결과는 값 하나 한도(256KiB) 때문에 따로 저장하고, 목록에는 그 키만 남긴다. 패널이 이슈 키로 옮긴다.
    const result = await lastAnswer(pane)
    let resultKey: string | undefined
    if (result) {
      resultKey = `pending:${randomUUID()}`
      await orca.storage.set(resultKey, result)
    }
    const list: unknown[] = (await orca.storage.get('completed')) ?? []
    await orca.storage.set('completed', [...list, { workspaceId: e.workspaceId, ...(resultKey ? { resultKey } : {}) }])
  })

  orca.panels.handle('repos.list', async () => {
    const { repos } = await orcaCli(['repo', 'list'])
    return repos.map((r: { id: string; displayName: string }) => ({ id: r.id, name: r.displayName }))
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
    // Orca가 --prompt의 첫 줄만 에이전트에 넣어서, 줄바꿈을 공백으로 펴서 보낸다.
    const prompt = promptWithImages(input.prompt, images).replace(/\s*\r?\n\s*/g, ' ')
    const result = await orcaCli(runArgs({ ...input, prompt }))
    // 완료 감지에 쓸 작업 트리 id. 새 트리는 CLI 응답에서, 기존 트리는 요청에서 얻는다.
    const workspaceId: string | undefined = input.worktreeId ?? result?.worktree?.id
    return { ok: true as const, ...(workspaceId ? { workspaceId } : {}) }
  })

  orca.panels.handle('result.open', async ({ title, question, key }) => {
    const text = ((await orca.storage.get(key)) as string | null) ?? ''
    const escape = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    const dir = join(homedir(), '.orca-issues', 'results')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${title.replace(/[^\w-]/g, '_')}.html`)
    await writeFile(
      file,
      `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title>
<style>body{max-width:960px;margin:32px auto;padding:0 20px;font:15px/1.7 system-ui,sans-serif}h1{font-size:18px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
h2{margin:24px 0 8px;font-size:14px;opacity:.7}.q{padding:12px;background:rgb(127 127 127/15%);border-radius:6px}#out>pre:first-child{font:inherit}pre code{display:block;padding:12px;background:rgb(127 127 127/15%);border-radius:6px}
table{border-collapse:collapse}th,td{padding:6px 12px;border:1px solid rgb(127 127 127/50%)}a{color:#4f8cff}</style>
<h1>${escape(title)} 에이전트 결과</h1>
<h2>질문</h2><pre class="q">${escape(question)}</pre>
<h2>답변</h2><div id="out"><pre>${escape(text)}</pre></div>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
<script>try{out.innerHTML=DOMPurify.sanitize(marked.parse(${JSON.stringify(text).replace(/</g, '\\u003c')}))}catch{}</script>`
    )
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : process.platform === 'darwin'
          ? ['open', [file]]
          : ['xdg-open', [file]]
    execFile(cmd, args, { windowsHide: true }, () => {})
    return { ok: true as const }
  })

  // 패널 iframe은 클립보드 쓰기가 막혀 있어서(navigator.clipboard 거부, execCommand는 무반응) worker가 OS 명령으로 복사한다.
  // 패널↔worker 메시지는 약 48KB라 결과 본문은 보내지 않고, worker가 저장소에서 읽어 문구를 만든다.
  orca.panels.handle('result.copy', async ({ key, prompt }) => {
    const text = handoffText(prompt, ((await orca.storage.get(key)) as string | null) ?? '')
    const [cmd, args] =
      process.platform === 'win32'
        ? ['powershell', ['-NoProfile', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::In.ReadToEnd() | Set-Clipboard']]
        : process.platform === 'darwin'
          ? ['pbcopy', []]
          : ['xclip', ['-selection', 'clipboard']]
    return new Promise<{ ok: true }>((resolve, reject) => {
      const child = execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve({ ok: true })))
      child.stdin!.end(text)
    })
  })

  // 자동 백업: 저장소의 프로젝트와 결과를 ~/.orca-issues/backups에 남긴다. 내용이 같으면 새로 만들지 않고 최근 BACKUP_KEEP개만 둔다.
  orca.panels.handle('backup.auto', async ({ reason }) => {
    const projects = ((await orca.storage.get('projects')) as Project[] | null) ?? []
    if (projects.length === 0) return { file: null }
    const results: Record<string, string> = {}
    for (const k of (await orca.storage.keys()).filter((k: string) => k.startsWith('result:'))) {
      results[k] = ((await orca.storage.get(k)) as string | null) ?? ''
    }
    const now = new Date()
    const data = buildBackup(projects, results, now)
    await mkdir(BACKUP_DIR, { recursive: true })
    const files = (await readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort()
    const strip = (t: string) => t.replace(/"exportedAt": "[^"]*"/, '')
    if (files.length > 0) {
      const last = await readFile(join(BACKUP_DIR, files[files.length - 1]), 'utf8').catch(() => '')
      if (strip(last) === strip(data)) return { file: null }
    }
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
    const file = join(BACKUP_DIR, `${stamp}-${reason ?? 'auto'}.json`)
    await writeFile(file, data)
    for (const old of [...files, basename(file)].sort().slice(0, -BACKUP_KEEP)) {
      await rm(join(BACKUP_DIR, old), { force: true })
    }
    return { file }
  })

  // 매뉴얼(docs/manual.html, 이미지는 docs/img)을 기본 브라우저에서 연다. 파일 위치는 이 worker 파일을 기준으로 찾는다.
  orca.panels.handle('manual.open', async () => {
    const file = fileURLToPath(new URL('../docs/manual.html', import.meta.url))
    await stat(file).catch(() => {
      throw new Error(`매뉴얼 파일을 찾을 수 없습니다: ${file}`)
    })
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : process.platform === 'darwin'
          ? ['open', [file]]
          : ['xdg-open', [file]]
    execFile(cmd, args, { windowsHide: true }, () => {})
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
