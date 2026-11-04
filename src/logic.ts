// 화면과 무관한 프로젝트·이슈 규칙. orca plugin test로 검증한다.

export const STATUSES = [
  { value: 'todo', label: '할 일' },
  { value: 'in_progress', label: '진행 중' },
  { value: 'done', label: '완료' }
]

// 처음에는 할 일만 펼친다.
export const DEFAULT_COLLAPSED = STATUSES.filter((s) => s.value !== 'todo').map((s) => s.label)

// ponytail: Orca에 에이전트 목록 API가 없어서 고정 목록을 쓴다. 생기면 그 API로 바꾼다.
export const AGENTS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' }
]

export type Issue = {
  number: number
  title: string
  description: string
  status: string
  createdAt: number
  images?: string[]
  repoId?: string
  agent?: string
  mode?: 'new' | 'existing'
  worktreeId?: string
  workspaceId?: string
  startedAt?: number
  // 이전에는 결과를 여기에 넣었다. 지금은 따로 저장하고, 백업 파일과 옛 데이터에만 남는다.
  result?: string
  runs?: RunRecord[]
}

// 이슈를 실행하거나 재개한 이력. 최근 MAX_RUNS개만 남긴다.
export type RunRecord = { at: number; agent: string; kind: 'run' | 'resume'; workspaceId?: string }
export const MAX_RUNS = 20
export const appendRun = (runs: RunRecord[] | undefined, run: RunRecord) => [...(runs ?? []), run].slice(-MAX_RUNS)

export type Project = {
  key: string
  name: string
  nextNumber: number
  issues: Issue[]
}

// 영문 이름은 앞 3글자(Engine → ENG), 약어를 만들 수 없는 이름은 P1, P2처럼 만든다.
export function autoKey(name: string, projects: Project[]) {
  const taken = new Set(projects.map((p) => p.key))
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 3)
  const base = letters.length >= 2 ? letters : 'P'
  if (base !== 'P' && !taken.has(base)) return base
  let n = 1
  while (taken.has(`${base}${n}`)) n++
  return `${base}${n}`
}

function keyError(projects: Project[], key: string) {
  if (!/^[A-Z][A-Z0-9]{1,4}$/.test(key)) return '키는 영문으로 시작하는 영문·숫자 2~5자입니다.'
  if (projects.some((p) => p.key === key)) return `${key} 키는 이미 사용 중입니다.`
}

export function createProject(projects: Project[], rawName: string, rawKey: string) {
  const name = rawName.trim()
  if (!name) return { error: '프로젝트 이름을 입력하세요.' }
  const typed = rawKey.trim().toUpperCase()
  const error = typed ? keyError(projects, typed) : undefined
  if (error) return { error }
  const key = typed || autoKey(name, projects)
  return { key, projects: [...projects, { key, name, nextNumber: 1, issues: [] }] }
}

// 이슈 번호는 키에서 만들어지므로 키를 바꾸면 TES-1이 NEW-1이 된다. 비워 두면 기존 키를 유지한다.
export function updateProject(projects: Project[], oldKey: string, rawName: string, rawKey: string) {
  const name = rawName.trim()
  if (!name) return { error: '프로젝트 이름을 입력하세요.' }
  const key = rawKey.trim().toUpperCase() || oldKey
  const others = projects.filter((p) => p.key !== oldKey)
  const error = key === oldKey ? undefined : keyError(others, key)
  if (error) return { error }
  return { key, projects: projects.map((p) => (p.key === oldKey ? { ...p, key, name } : p)) }
}

export const deleteProject = (projects: Project[], key: string) =>
  projects.filter((p) => p.key !== key)

export function addIssue(
  projects: Project[],
  key: string,
  fields: {
    title: string
    description: string
    images?: string[]
    repoId?: string
    agent?: string
    mode?: 'new' | 'existing'
    worktreeId?: string
  },
  now: number
) {
  return projects.map((p) =>
    p.key === key
      ? {
          ...p,
          nextNumber: p.nextNumber + 1,
          issues: [
            ...p.issues,
            // Orca 저장소는 undefined 값을 거부한다(Invalid input). 값이 없는 키는 아예 넣지 않는다.
            Object.fromEntries(
              Object.entries({
                title: fields.title.trim(),
                description: fields.description.trim(),
                status: 'todo',
                createdAt: now,
                images: fields.images ?? [],
                repoId: fields.repoId,
                agent: fields.agent,
                mode: fields.mode,
                worktreeId: fields.mode === 'existing' ? fields.worktreeId : undefined,
                number: p.nextNumber
              }).filter(([, v]) => v !== undefined)
            ) as Issue
          ]
        }
      : p
  )
}

export function patchIssue(projects: Project[], key: string, number: number, patch: Partial<Issue>) {
  return projects.map((p) =>
    p.key === key
      ? { ...p, issues: p.issues.map((i) => (i.number === number ? { ...i, ...patch } : i)) }
      : p
  )
}

// nextNumber는 줄이지 않는다. 지운 이슈의 번호를 다시 쓰면 작업 트리 이름과 겹친다.
export function deleteIssue(projects: Project[], key: string, number: number) {
  return projects.map((p) =>
    p.key === key ? { ...p, issues: p.issues.filter((i) => i.number !== number) } : p
  )
}

export function groupIssues(project: Project) {
  return STATUSES.map(({ value, label }) => ({
    label,
    issues: project.issues
      .filter((i) => i.status === value)
      .sort((a, b) => b.number - a.number)
  }))
}

export const canRun = (issue: Issue) => issue.status !== 'done'

export const imageToken = (n: number) => `[Image #${n}]`

// 설명에 남은 토큰의 이미지만 남기고 1부터 다시 번호를 매긴다.
// 저장된 이슈는 images[i]가 [Image #i+1]에 대응한다.
export function finalizeImages(description: string, images: { n: number; name: string }[]) {
  const kept = images.filter((image) => description.includes(imageToken(image.n)))
  return {
    description: description.replace(/\[Image #(\d+)\]/g, (token, n) => {
      const index = kept.findIndex((image) => image.n === Number(n))
      return index < 0 ? token : imageToken(index + 1)
    }),
    images: kept.map((image) => image.name)
  }
}

export const issueId = (project: Project, issue: Issue) => `${project.key}-${issue.number}`

export const issuePrompt = (project: Project, issue: Issue) =>
  `${issueId(project, issue)} ${issue.title}\n\n${issue.description}`.trim()

// 새 트리는 worktreeId 키가 없어야 한다. undefined는 JSON이 아니라서 요청이 거부된다.
export function runRequest(
  project: Project,
  issue: Issue,
  repoId: string,
  agent: string,
  worktreeId?: string
) {
  return {
    repoId,
    ...(worktreeId ? { worktreeId } : {}),
    agent,
    name: issueId(project, issue),
    prompt: issuePrompt(project, issue),
    images: issue.images ?? []
  }
}

// 에이전트 결과는 값 하나가 256KiB를 넘을 수 없어서 이슈와 따로 저장한다. 한글은 글자당 최대 3바이트라 8만 자로 막는다.
// 프로젝트 키를 바꿔도 이어지도록 번호와 생성 시각으로 키를 만든다.
export const RESULT_MAX = 80_000
export const resultKey = (issue: Pick<Issue, 'number' | 'createdAt'>) => `result:${issue.number}-${issue.createdAt}`

export function cloneIssue(projects: Project[], key: string, number: number, now: number) {
  const src = projects.find((p) => p.key === key)?.issues.find((i) => i.number === number)
  if (!src) return projects
  const { title, description, images, repoId, agent, mode, worktreeId } = src
  return addIssue(projects, key, { title, description, images, repoId, agent, mode, worktreeId }, now)
}

export function deleteIssues(projects: Project[], key: string, numbers: number[]) {
  const gone = new Set(numbers)
  return projects.map((p) => (p.key === key ? { ...p, issues: p.issues.filter((i) => !gone.has(i.number)) } : p))
}

export function setStatuses(projects: Project[], key: string, numbers: number[], status: string) {
  const chosen = new Set(numbers)
  return projects.map((p) =>
    p.key === key ? { ...p, issues: p.issues.map((i) => (chosen.has(i.number) ? { ...i, status } : i)) } : p
  )
}

// 새 세션에 붙여 이어서 작업할 때 쓰는 인계 문구. 복사와 재개가 같이 쓴다.
export function handoffText(prompt: string, result: string, maxResult = Infinity) {
  const text = result.trim()
  return [
    '이전 세션에서 진행한 이슈를 이어서 작업합니다.',
    `## 이슈\n${prompt}`,
    `## 이전 에이전트 결과\n${text.length > maxResult ? `${text.slice(0, maxResult)}…(이하 생략)` : text}`,
    '위 내용을 참고해 이어서 작업해 주세요.'
  ].join('\n\n')
}

// 백업 파일은 결과를 이슈 안에 넣어 한 파일로 끝낸다. 예전 백업(결과가 이슈 안에 있던 형식)도 그대로 읽힌다.
export function buildBackup(projects: Project[], results: Record<string, string>, now: Date) {
  return JSON.stringify(
    {
      version: 2,
      exportedAt: now.toISOString(),
      projects: projects.map((p) => ({
        ...p,
        issues: p.issues.map((i) => {
          const result = results[resultKey(i)]
          return result ? { ...i, result } : i
        })
      }))
    },
    null,
    2
  )
}

export function parseBackup(text: string) {
  const list = JSON.parse(text)?.projects
  if (!Array.isArray(list) || !list.every((p) => p && typeof p.key === 'string' && typeof p.name === 'string' && Array.isArray(p.issues))) {
    throw new Error('이 플러그인의 백업 파일이 아닙니다.')
  }
  const results: Record<string, string> = {}
  const projects = (list as Project[]).map((p) => ({
    ...p,
    issues: p.issues.map(({ result, ...issue }) => {
      if (result) results[resultKey(issue)] = result.slice(0, RESULT_MAX)
      return issue
    })
  }))
  return { projects, results }
}
