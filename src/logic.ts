// 화면과 무관한 프로젝트·이슈 규칙. orca plugin test로 검증한다.

export const STATUSES = [
  { value: 'todo', label: '할 일' },
  { value: 'in_progress', label: '진행 중' },
  { value: 'done', label: '완료' }
]

// 처음에는 할 일만 펼친다.
export const DEFAULT_COLLAPSED = STATUSES.filter((s) => s.value !== 'todo').map((s) => s.label)

// 정렬 순서이기도 하다: 위에 있을수록 먼저 표시된다.
export const PRIORITIES = [
  { value: 'urgent', label: '긴급' },
  { value: 'high', label: '높음' },
  { value: 'medium', label: '보통' },
  { value: 'low', label: '낮음' },
  { value: 'none', label: '우선순위 없음' }
]

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
  priority: string
  createdAt: number
  images?: string[]
}

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

// 키는 이슈 번호의 일부(TES-1)라서 만든 뒤에는 바꾸지 않는다.
export function updateProject(projects: Project[], key: string, rawName: string) {
  const name = rawName.trim()
  if (!name) return { error: '프로젝트 이름을 입력하세요.' }
  return { key, projects: projects.map((p) => (p.key === key ? { ...p, name } : p)) }
}

export const deleteProject = (projects: Project[], key: string) =>
  projects.filter((p) => p.key !== key)

export function addIssue(
  projects: Project[],
  key: string,
  fields: { title: string; description: string; priority: string; images?: string[] },
  now: number
) {
  return projects.map((p) =>
    p.key === key
      ? {
          ...p,
          nextNumber: p.nextNumber + 1,
          issues: [
            ...p.issues,
            {
              title: fields.title.trim(),
              description: fields.description.trim(),
              status: 'todo',
              priority: fields.priority,
              createdAt: now,
              images: fields.images ?? [],
              number: p.nextNumber
            }
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

const priorityRank = (issue: Issue) => PRIORITIES.findIndex((p) => p.value === issue.priority)

export const priorityLabel = (issue: Issue) => PRIORITIES[priorityRank(issue)]?.label ?? ''

export function groupIssues(project: Project) {
  return STATUSES.map(({ value, label }) => ({
    label,
    issues: project.issues
      .filter((i) => i.status === value)
      .sort((a, b) => priorityRank(a) - priorityRank(b) || b.number - a.number)
  }))
}

export const canRun = (issue: Issue) => issue.status === 'todo'

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
