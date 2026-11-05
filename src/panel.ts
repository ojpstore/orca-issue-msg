import {
  addIssue,
  AGENTS,
  appendFollowUp,
  appendRun,
  buildBackup,
  canRun,
  cloneIssue,
  createProject,
  DEFAULT_COLLAPSED,
  deleteIssue,
  deleteIssues,
  deleteProject,
  finalizeImages,
  groupIssues,
  handoffText,
  imageToken,
  isStuck,
  issueId,
  issueMatches,
  issuePrompt,
  parseBackup,
  parseSettings,
  patchIssue,
  resultKey,
  routeCompleted,
  runRequest,
  SEARCH_FIELDS,
  setStatuses,
  STATUSES,
  updateProject,
  type Issue,
  type Project
} from './logic'

declare const orca: any

type Option = { value: string; label: string }
type Repo = { id: string; name: string }
type Tree = { id: string; name: string }
type Run = {
  project: Project
  issue: Issue
  repos: Repo[] | null
  repoId: string
  trees: Tree[] | null
  worktreeId: string
  mode: 'new' | 'existing'
  confirmed: boolean
  busy: boolean
  error: string
}

const app = document.getElementById('app') as HTMLElement
const dialog = document.getElementById('run') as HTMLDialogElement
const projectDialog = document.getElementById('project') as HTMLDialogElement
const issueDialog = document.getElementById('issue') as HTMLDialogElement
const detailDialog = document.getElementById('detail') as HTMLDialogElement
const settingsDialog = document.getElementById('settings') as HTMLDialogElement

let projects: Project[] = []
let selectedKey = ''
let lastRepo = ''
let lastAgent = AGENTS[0].value
let settings = parseSettings(null)
// 설정 창에서 고치는 사본. 저장을 눌러야 settings에 들어간다.
let settingsDraft = settings
let defaultBackupDir = ''
let settingsError = ''
let savingSettings = false
let pickingDir = false
// 에이전트가 동작 중인 작업 트리. 확인하기 전(null)에는 멈춘 것으로 보지 않는다.
let activeWorkspaces: Set<string> | null = null
let stuckKey = ''
let settingsTab = 0
let saveError = ''
let projectError = ''
let editingKey: string | null = null
let confirmingDelete = false
let run: Run | null = null
let detail: { key: string; number: number } | null = null
let confirmingIssueDelete = false
let historyOpen = false
let editingTitle = false
let collapsed = new Set<string>()
const projectDraft = { name: '', key: '' }
const issueDraft = {
  title: '',
  description: '',
  repoId: '',
  agent: AGENTS[0].value,
  mode: 'existing' as 'new' | 'existing',
  worktreeId: '',
  images: [] as { n: number; name: string }[],
  nextImage: 1
}
const imageUrls = new Map<string, string>()
let draftImages: HTMLElement | null = null
let draftDescription: HTMLTextAreaElement | null = null
let imageError = ''
let uploading = 0
let issueRepos: Repo[] | null = null
let issueTrees: Tree[] | null = null

// Orca의 패널-worker 메시지 한도(약 48KB)보다 작은 4의 배수.
const IMAGE_CHUNK = 40_000
const MAX_IMAGE_BYTES = 10 << 20

// 조각이 많으면 Orca의 호출 한도에 걸린다. 안내된 시간만큼 기다렸다 다시 보낸다.
async function request(name: string, input: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await orca.plugin.request(name, input)
    } catch (e: any) {
      if (e.code !== 'rate_limited' || attempt >= 5) throw e
      await new Promise((resolve) => setTimeout(resolve, e.retryAfterMs ?? 1000))
    }
  }
}

async function readImage(name: string) {
  let base64 = ''
  for (let offset = 0; ; ) {
    const { type, data, size } = await request('image.read', { name, offset })
    base64 += data
    offset += (data.length / 4) * 3
    if (!data || offset >= size) return `data:${type};base64,${base64}`
  }
}

// 사용자 입력은 모두 textContent로 들어간다. innerHTML을 쓰지 않는다.
function el(tag: string, props: Record<string, any> = {}, ...children: any[]): any {
  const node: any = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value)
    else node[name] = value
  }
  node.append(...children.filter((child) => child !== null && child !== undefined))
  return node
}

function field(label: string, control: HTMLElement) {
  return el('label', {}, label, control)
}

function select(
  label: string,
  options: Option[],
  value: string,
  onChange: (value: string) => void,
  disabled = false,
  placeholder = ''
) {
  const control = el(
    'select',
    { disabled: disabled || options.length === 0, onchange: (e: any) => onChange(e.target.value) },
    ...(options.length === 0 ? [el('option', { value: '' }, placeholder)] : []),
    ...options.map((o) => el('option', { value: o.value }, o.label))
  )
  control.value = options.length === 0 ? '' : value
  return field(label, control)
}

function imageTag(name: string) {
  const img = el('img', { alt: '첨부 이미지' })
  const cached = imageUrls.get(name)
  if (cached) {
    img.src = cached
    return img
  }
  readImage(name)
    .then((dataUrl) => {
      imageUrls.set(name, dataUrl)
      img.src = dataUrl
    })
    .catch(() => (img.alt = '이미지를 읽을 수 없습니다'))
  return img
}

function renderDraftImages() {
  draftImages?.replaceChildren(
    ...issueDraft.images.map(({ n, name }) =>
      el(
        'div',
        { className: 'thumb' },
        imageTag(name),
        el('span', {}, `#${n}`),
        el(
          'button',
          {
            type: 'button',
            className: 'icon',
            ariaLabel: '이미지 제거',
            // ponytail: 파일은 지우지 않아 남는다. 쌓이면 이슈에서 참조하지 않는 파일을 정리한다.
            onclick: () => removeToken(n)
          },
          '✕'
        )
      )
    ),
    ...(uploading ? [el('div', { className: 'muted' }, '이미지 저장 중…')] : []),
    ...(imageError ? [el('div', { className: 'error' }, imageError)] : [])
  )
}

// 에이전트 컨텍스트와 전송량을 아끼려고 큰 이미지는 긴 변 1568px(글자가 읽히는 크기)로 줄인다. GIF는 그대로 둔다.
const MAX_SIDE = 1568
async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 500_000) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob: Blob | null = await new Promise((done) => canvas.toBlob(done, file.type, 0.85))
    return blob && blob.type === file.type && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

async function uploadImage(original: File) {
  const file = await shrinkImage(original)
  if (file.size > MAX_IMAGE_BYTES) throw new Error('이미지는 10MB까지 붙여넣을 수 있습니다.')
  const dataUrl = await readAsDataUrl(file)
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const { name } = await request('image.start', { type: file.type })
  for (let i = 0; i < base64.length; i += IMAGE_CHUNK) {
    await request('image.append', { name, data: base64.slice(i, i + IMAGE_CHUNK) })
  }
  imageUrls.set(name, dataUrl)
  return name
}

function setDescription(value: string) {
  issueDraft.description = value
  if (draftDescription) draftDescription.value = value
  syncDraftImages()
}

function removeToken(n: number) {
  setDescription(issueDraft.description.replace(`${imageToken(n)} `, '').replace(imageToken(n), ''))
}

// 설명에서 토큰을 지우면 그 이미지도 뺀다.
function syncDraftImages() {
  const kept = issueDraft.images.filter((i) => issueDraft.description.includes(imageToken(i.n)))
  if (kept.length === issueDraft.images.length) return
  issueDraft.images = kept
  renderDraftImages()
}

function readAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'))
    reader.readAsDataURL(file)
  })
}

// 이미지가 없으면 기본 붙여넣기를 그대로 둔다.
async function pasteImages(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  e.preventDefault()
  imageError = ''
  // 저장을 기다리지 않고 토큰을 바로 넣어 이어서 입력할 수 있게 한다.
  const numbers = files.map(() => issueDraft.nextImage++)
  const target = e.target as HTMLTextAreaElement
  target.setRangeText(`${numbers.map(imageToken).join(' ')} `, target.selectionStart, target.selectionEnd, 'end')
  issueDraft.description = target.value
  uploading++
  renderDraftImages()
  for (const [i, file] of files.entries()) {
    try {
      const name = await uploadImage(file)
      if (issueDraft.description.includes(imageToken(numbers[i]))) {
        issueDraft.images = [...issueDraft.images, { n: numbers[i], name }]
      }
    } catch (err) {
      imageError = (err as Error).message
      removeToken(numbers[i])
    }
    renderDraftImages()
  }
  uploading--
  renderDraftImages()
}

// 에이전트 결과는 값 하나 한도 때문에 이슈와 따로 저장하고, 화면에서는 이 맵에서 읽는다.
const results = new Map<string, string>()
const resultOf = (issue: Issue) => results.get(resultKey(issue)) ?? ''

function saveResult(issue: Issue, text: string) {
  const key = resultKey(issue)
  results.set(key, text)
  orca.storage.set(key, text).catch((e: Error) => {
    saveError = `결과 저장 실패: ${e.message}`
    render()
  })
  scheduleAutoBackup()
}

function dropResults(issues: Issue[]) {
  for (const issue of issues) {
    results.delete(resultKey(issue))
    orca.storage.delete(resultKey(issue)).catch(() => {})
  }
}

// 저장할 때마다 worker가 백업 폴더에 남기게 한다. 연달아 바뀌면 마지막 한 번만 요청한다.
let backupTimer: ReturnType<typeof setTimeout> | undefined
function scheduleAutoBackup() {
  clearTimeout(backupTimer)
  if (!settings.autoBackup) return
  backupTimer = setTimeout(() => orca.plugin.request('backup.auto', {}).catch((e: Error) => {
      saveError = `자동 백업 실패: ${e.message}`
      render()
    }), 5000)
}

function saveProjects() {
  orca.storage.set('projects', projects).catch((e: Error) => {
    saveError = `저장 실패: ${e.message}`
    render()
  })
  scheduleAutoBackup()
}

// 이슈를 시작하거나 재개한 이력. 가장 최근 값에 덧붙인다.
function runsPatch(key: string, number: number, agent: string, kind: 'run' | 'resume', workspaceId?: string) {
  const current = projects.find((p) => p.key === key)?.issues.find((i) => i.number === number)
  return { runs: appendRun(current?.runs, { at: Date.now(), agent, kind, ...(workspaceId ? { workspaceId } : {}) }) }
}

// worker가 남긴 '끝난 작업 트리' 목록을 보고 진행 중 이슈를 완료로 옮긴다.
async function applyCompleted() {
  type Completed = { workspaceId: string; paneKey?: string; prompt?: string; result?: string; resultKey?: string }
  const raw: (string | Completed)[] = (await orca.storage.get('completed')) ?? []
  const done = raw.map((d) => (typeof d === 'string' ? { workspaceId: d } : d) as Completed)
  if (done.length === 0) return
  await orca.storage.set('completed', [])
  // 종료 한 건마다 이슈 하나만 바꾼다. 완료된 이슈의 pane이면 이어서 작업한 답변이고, 아니면 진행 중 이슈를 완료로 옮긴다.
  let changed = false
  for (const { workspaceId: id, paneKey, prompt, result: inline, resultKey: pending } of done) {
    // worker가 따로 저장해 둔 결과를 읽고, 이슈 키로 옮긴 뒤 임시 키를 지운다.
    const result: string | undefined = pending ? ((await orca.storage.get(pending)) ?? undefined) : inline
    if (pending) orca.storage.delete(pending).catch(() => {})
    const target = routeCompleted(projects, id, paneKey)
    if (!target) continue
    const { key, issue, followUp } = target
    if (followUp) {
      if (result) saveResult(issue, appendFollowUp(resultOf(issue), prompt ?? '', result, new Date().toLocaleString('ko-KR')))
      continue
    }
    const panes = paneKey && !issue.panes?.includes(paneKey) ? [...(issue.panes ?? []), paneKey] : issue.panes
    projects = patchIssue(projects, key, issue.number, { status: 'done', panes })
    if (result) saveResult(issue, result)
    changed = true
  }
  if (!changed) return
  saveProjects()
  render()
}

// 메모는 입력할 때마다 메모리에 넣고, 저장은 입력이 멈추거나 창이 닫힐 때 한 번만 한다.
let memoTimer: ReturnType<typeof setTimeout> | undefined
function flushMemo() {
  if (memoTimer === undefined) return
  clearTimeout(memoTimer)
  memoTimer = undefined
  saveProjects()
}

const stuckNow = (issue: Issue) => activeWorkspaces !== null && isStuck(issue, activeWorkspaces, Date.now())

// 에이전트가 죽으면 이벤트가 오지 않아서 주기적으로 확인한다. 진행 중 이슈가 없으면 아무것도 하지 않는다.
async function refreshActive() {
  const running = projects.flatMap((p) => p.issues.filter((i) => i.status === 'in_progress'))
  if (running.length === 0) return
  activeWorkspaces = new Set((await orca.plugin.request('agents.active', {})).active)
  const key = running.filter(stuckNow).map(resultKey).join()
  if (key === stuckKey) return
  stuckKey = key
  render()
}

function saveSetting(key: string, value: unknown) {
  orca.storage.set(key, value).catch(() => {})
}

function submitProject(e: Event) {
  e.preventDefault()
  const result = editingKey
    ? updateProject(projects, editingKey, projectDraft.name, projectDraft.key)
    : createProject(projects, projectDraft.name, projectDraft.key)
  if (result.error) {
    projectError = result.error
    return projectDialog.open ? renderProjectDialog() : render()
  }
  projects = result.projects as Project[]
  selectedKey = result.key as string
  editingKey = null
  projectDraft.name = ''
  projectDraft.key = ''
  projectError = ''
  saveProjects()
  saveSetting('selectedKey', selectedKey)
  if (projectDialog.open) projectDialog.close()
  render()
}

function openProjectDialog(project: Project | null) {
  editingKey = project?.key ?? null
  confirmingDelete = false
  projectDraft.name = project?.name ?? ''
  projectDraft.key = project?.key ?? ''
  projectError = ''
  renderProjectDialog()
  projectDialog.showModal()
}

function removeProject(key: string) {
  dropResults(projects.find((p) => p.key === key)?.issues ?? [])
  projects = deleteProject(projects, key)
  selectedKey = projects[0]?.key ?? ''
  editingKey = null
  projectDraft.name = ''
  projectDraft.key = ''
  saveProjects()
  saveSetting('selectedKey', selectedKey)
  projectDialog.close()
  render()
}

function deleteSection(key: string) {
  const project = projects.find((p) => p.key === key) as Project
  if (!confirmingDelete) {
    return el(
      'button',
      {
        type: 'button',
        className: 'danger',
        onclick: () => {
          confirmingDelete = true
          renderProjectDialog()
        }
      },
      '프로젝트 삭제'
    )
  }
  return el(
    'div',
    { className: 'stack' },
    el('div', {}, `${project.name} 프로젝트를 삭제하시겠습니까?`),
    el(
      'div',
      { className: 'error' },
      `프로젝트 삭제 시 해당 이슈들이 모두 삭제됩니다. (이슈 ${project.issues.length}개) 되돌릴 수 없습니다.`
    ),
    el(
      'div',
      { className: 'row' },
      el('button', { type: 'button', className: 'danger solid', onclick: () => removeProject(key) }, '삭제 확인'),
      el(
        'button',
        {
          type: 'button',
          className: 'ghost',
          onclick: () => {
            confirmingDelete = false
            renderProjectDialog()
          }
        },
        '삭제 취소'
      )
    )
  )
}

function renderProjectDialog() {
  projectDialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('h2', {}, editingKey ? '프로젝트 수정' : '새 프로젝트'),
        el(
          'button',
          { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: () => projectDialog.close() },
          '✕'
        )
      ),
      projectForm(true),
      editingKey ? el('hr') : null,
      editingKey ? deleteSection(editingKey) : null
    )
  )
}

function projectForm(cancellable: boolean) {
  return el(
    'form',
    { onsubmit: submitProject },
    field(
      '프로젝트 이름',
      el('input', {
        autofocus: cancellable,
        value: projectDraft.name,
        maxLength: 80,
        oninput: (e: any) => (projectDraft.name = e.target.value)
      })
    ),
    field(
      '프로젝트 키',
      el('input', {
        value: projectDraft.key,
        maxLength: 5,
        placeholder: editingKey ? '비워 두면 유지' : '비워 두면 자동 생성',
        oninput: (e: any) => (projectDraft.key = e.target.value)
      })
    ),
    projectError ? el('div', { className: 'error' }, projectError) : null,
    el(
      'div',
      { className: 'row' },
      el('button', { type: 'submit', className: 'primary' }, editingKey ? '저장' : '프로젝트 만들기'),
      cancellable
        ? el(
            'button',
            { type: 'button', className: 'ghost', onclick: () => projectDialog.close() },
            '취소'
          )
        : null
    )
  )
}

function clearIssueDraft() {
  issueDraft.title = ''
  issueDraft.description = ''
  issueDraft.images = []
  issueDraft.nextImage = 1
  issueDraft.mode = 'existing'
  imageError = ''
}

// ✕와 Esc는 작성 중인 내용을 남긴다. 실수로 닫아도 잃지 않도록, 지우는 건 취소뿐이다.
async function loadIssueRepos(project: Project) {
  issueRepos = null
  issueTrees = null
  try {
    issueRepos = await orca.plugin.request('repos.list')
  } catch {
    issueRepos = []
  }
  const repos = issueRepos ?? []
  if (!repos.some((r) => r.id === issueDraft.repoId)) {
    issueDraft.repoId = (repos.find((r) => r.id === lastRepo) ?? repos[0])?.id ?? ''
  }
  if (issueDialog.open) renderIssueDialog(project)
  loadIssueTrees(project)
}

// 기존 트리 방식일 때만 불러온다.
async function loadIssueTrees(project: Project) {
  issueTrees = null
  issueDraft.worktreeId = ''
  if (issueDialog.open) renderIssueDialog(project)
  const repoId = issueDraft.repoId
  let trees: Tree[] = []
  if (issueDraft.mode === 'existing' && repoId) {
    try {
      trees = await orca.plugin.request('worktrees.list', { repoId })
    } catch {}
    if (issueDraft.repoId !== repoId || issueDraft.mode !== 'existing') return
  }
  issueTrees = trees
  issueDraft.worktreeId = trees[0]?.id ?? ''
  if (issueDialog.open) renderIssueDialog(project)
}

function renderIssueDialog(project: Project) {
  issueDialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('h2', {}, '새 이슈'),
        el(
          'button',
          { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: () => issueDialog.close() },
          '✕'
        )
      ),
      issueForm(project)
    )
  )
  renderDraftImages()
}

function issueForm(project: Project) {
  const submit = el('button', { type: 'submit', className: 'primary', disabled: !issueDraft.title.trim() }, '이슈 등록')
  const title = el('input', {
    autofocus: true,
    value: issueDraft.title,
    maxLength: 200,
    oninput: (e: any) => {
      issueDraft.title = e.target.value
      submit.disabled = !issueDraft.title.trim()
    }
  })
  return el(
    'form',
    {
      onsubmit: (e: Event) => {
        e.preventDefault()
        if (!issueDraft.title.trim()) return
        if (uploading) {
          imageError = '이미지 저장이 끝난 뒤 등록하세요.'
          return renderDraftImages()
        }
        projects = addIssue(
          projects,
          project.key,
          { ...issueDraft, ...finalizeImages(issueDraft.description, issueDraft.images) },
          Date.now()
        )
        clearIssueDraft()
        saveProjects()
        issueDialog.close()
        render()
      }
    },
    field('이슈 제목', title),
    field(
      '설명',
      (draftDescription = el('textarea', {
        rows: 10,
        maxLength: 8000,
        placeholder: '이미지를 붙여넣을 수 있습니다',
        value: issueDraft.description,
        onpaste: pasteImages,
        oninput: (e: any) => {
          issueDraft.description = e.target.value
          syncDraftImages()
        }
      }))
    ),
    (draftImages = el('div', { className: 'thumbs' })),
    select(
      'Orca 프로젝트',
      (issueRepos ?? []).map((r) => ({ value: r.id, label: r.name })),
      issueDraft.repoId,
      (id) => {
        issueDraft.repoId = id
        loadIssueTrees(project)
      },
      false,
      issueRepos ? '프로젝트 없음' : '불러오는 중'
    ),
    select('에이전트', AGENTS, issueDraft.agent, (agent) => (issueDraft.agent = agent)),
    el(
      'fieldset',
      {},
      el('legend', {}, '실행 방식'),
      ...(['new', 'existing'] as const).map((value) =>
        el(
          'label',
          { className: 'radio' },
          el('input', {
            type: 'radio',
            name: 'issue-mode',
            checked: issueDraft.mode === value,
            onchange: () => {
              issueDraft.mode = value
              loadIssueTrees(project)
            }
          }),
          value === 'new' ? '새 트리로 실행' : '기존 트리로 실행'
        )
      )
    ),
    issueDraft.mode === 'existing'
      ? select(
          '작업 트리',
          (issueTrees ?? []).map((t) => ({ value: t.id, label: t.name })),
          issueDraft.worktreeId,
          (id) => (issueDraft.worktreeId = id),
          false,
          issueTrees ? '이 프로젝트에 작업 트리 없음' : '불러오는 중'
        )
      : null,
    el(
      'div',
      { className: 'row' },
      submit,
      el(
        'button',
        {
          type: 'button',
          className: 'ghost',
          onclick: () => {
            clearIssueDraft()
            issueDialog.close()
          }
        },
        '취소'
      )
    )
  )
}

function issueRow(project: Project, issue: Issue) {
  const id = issueId(project, issue)
  if (selectMode) {
    const running = issue.status === 'in_progress'
    return el(
      'div',
      { className: 'row issue-card' },
      el(
        'button',
        {
          type: 'button',
          className: 'issue-open',
          title: running ? '진행 중인 이슈는 선택할 수 없습니다' : '선택',
          disabled: running,
          onclick: () => {
            if (selected.has(issue.number)) selected.delete(issue.number)
            else selected.add(issue.number)
            bulkDeleteAsk = false
            render()
          }
        },
        el('span', {}, selected.has(issue.number) ? '☑' : '☐'),
        el('span', { className: 'issue-id' }, id),
        el('span', { className: 'issue-title' }, issue.title)
      )
    )
  }
  return el(
    'div',
    { className: 'row issue-card' },
    el(
      'button',
      {
        type: 'button',
        className: 'issue-open',
        title: issue.status === 'in_progress' ? '진행 중에는 열 수 없습니다' : '이슈 보기',
        disabled: issue.status === 'in_progress',
        onclick: () => openDetail(project.key, issue.number)
      },
      el('span', { className: 'issue-id' }, id),
      el('span', { className: 'issue-title' }, issue.title),
    ),
    canRun(issue, stuckNow(issue))
      ? el(
          'button',
          {
            type: 'button',
            className: 'icon run',
            title: issue.status === 'in_progress' ? '에이전트가 동작하지 않습니다. 다시 실행합니다' : '작업 실행',
            ariaLabel: `${id} 실행`,
            onclick: () => openRun(project, issue)
          },
          '▶'
        )
      : null
  )
}

function openDetail(key: string, number: number) {
  detail = { key, number }
  confirmingIssueDelete = false
  editingTitle = false
  historyOpen = false
  renderDetail()
  detailDialog.showModal()
}

function removeIssue(key: string, number: number) {
  dropResults(projects.find((p) => p.key === key)?.issues.filter((i) => i.number === number) ?? [])
  projects = deleteIssue(projects, key, number)
  detail = null
  saveProjects()
  detailDialog.close()
  render()
}

function duplicateIssue(key: string, number: number) {
  projects = cloneIssue(projects, key, number, Date.now())
  issueQuery = ''
  detail = null
  saveProjects()
  detailDialog.close()
  render()
}

function detailActions(project: Project, issue: Issue) {
  const setConfirming = (value: boolean) => () => {
    confirmingIssueDelete = value
    renderDetail()
  }
  if (!confirmingIssueDelete) {
    return el(
      'div',
      { className: 'row' },
      el('button', { type: 'button', className: 'danger', onclick: setConfirming(true) }, '이슈 삭제'),
      el('button', { type: 'button', title: '같은 제목·설명·실행 설정으로 할 일 이슈를 새로 만듭니다', onclick: () => duplicateIssue(project.key, issue.number) }, '복제'),
      el('button', { type: 'button', className: 'ghost', onclick: () => detailDialog.close() }, '취소')
    )
  }
  return el(
    'div',
    { className: 'stack' },
    el('div', {}, `${issueId(project, issue)} 이슈를 삭제하시겠습니까?`),
    el('div', { className: 'error' }, '되돌릴 수 없습니다.'),
    el(
      'div',
      { className: 'row' },
      el(
        'button',
        { type: 'button', className: 'danger solid', onclick: () => removeIssue(project.key, issue.number) },
        '삭제 확인'
      ),
      el('button', { type: 'button', className: 'ghost', onclick: setConfirming(false) }, '삭제 취소')
    )
  )
}

function titleView(issue: Issue) {
  const title = el('div', { className: 'description detail-title grow' }, issue.title)
  if (issue.status !== 'done') return title
  return el(
    'div',
    { className: 'row' },
    title,
    el(
      'button',
      {
        type: 'button',
        className: 'ghost',
        title: '제목 수정',
        ariaLabel: '제목 수정',
        onclick: () => {
          editingTitle = true
          renderDetail()
        }
      },
      '수정'
    )
  )
}

function titleEditor(current: string, update: (patch: Partial<Issue>) => void) {
  const input = el('input', { value: current, ariaLabel: '이슈 제목' }) as HTMLInputElement
  const close = () => {
    editingTitle = false
    renderDetail()
  }
  const save = () => {
    const title = input.value.trim()
    if (!title) return input.focus()
    editingTitle = false
    update({ title })
  }
  input.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') {
      e.preventDefault() // 다이얼로그 전체가 닫히지 않게 한다
      close()
    }
  }
  setTimeout(() => input.select())
  return el(
    'div',
    { className: 'row' },
    el('div', { className: 'grow' }, input),
    el('button', { type: 'button', className: 'primary', onclick: save }, '저장'),
    el('button', { type: 'button', className: 'ghost', onclick: close }, '취소')
  )
}

const RESUME_RESULT_MAX = 1500

// ponytail: Orca CLI에 세션 재개 명령이 없어, 같은 작업 트리에서 에이전트를 새로 열고 인계 문구를 프롬프트로 넘긴다.
function resumeButton(project: Project, issue: Issue) {
  if (!issue.repoId || !issue.workspaceId) return null
  const btn = el(
    'button',
    {
      type: 'button',
      className: 'run',
      title: '이슈를 진행한 작업 트리에서 에이전트를 새로 열고 이전 결과를 이어서 전달',
      onclick: async () => {
        btn.disabled = true
        try {
          // 새로 만든 작업 공간은 이미 사라졌을 수 있어(selector_not_found), 남아 있는 트리로 대신한다.
          const trees: Tree[] = await orca.plugin.request('worktrees.list', { repoId: issue.repoId })
          const tree = trees.find((t) => t.id === issue.workspaceId) ?? trees.find((t) => t.id === issue.worktreeId) ?? trees[0]
          if (!tree) throw new Error('이 프로젝트에 작업 트리가 없습니다.')
          const started = await orca.plugin.request(
            'issue.run',
            {
              ...runRequest(project, issue, issue.repoId!, issue.agent ?? AGENTS[0].value, tree.id),
              // 재개는 토큰을 아끼려고 결과의 최근 부분만 넘긴다. 전체가 필요하면 복사 버튼을 쓴다.
              prompt: handoffText(issuePrompt(project, issue), resultOf(issue), RESUME_RESULT_MAX)
            },
            { timeoutMs: 120000 }
          )
          projects = patchIssue(projects, project.key, issue.number, {
            ...runsPatch(project.key, issue.number, issue.agent ?? AGENTS[0].value, 'resume', tree.id),
            ...(started.paneKey ? { panes: [...(issue.panes ?? []), started.paneKey] } : {})
          })
          saveProjects()
          render()
          renderDetail()
        } catch (e) {
          saveError = `재개 실패: ${(e as Error).message}`
          render()
        } finally {
          btn.disabled = false
        }
      }
    },
    '▷ 워크트리에서 재개'
  )
  return btn
}

// 접었을 때 보이는 이력 수. 숨기는 규칙은 panel.html의 .run-history에 있다.
const HISTORY_PREVIEW = 3

function runHistory(issue: Issue) {
  const runs = issue.runs ?? []
  if (runs.length === 0) return null
  const label = (id: string) => AGENTS.find((a) => a.value === id)?.label ?? id
  const toggleText = () => (historyOpen ? '접기' : `${runs.length - HISTORY_PREVIEW}건 더 보기`)
  // 메모를 입력하던 내용과 커서가 유지되도록 팝업을 다시 그리지 않고 표시만 바꾼다.
  const toggle =
    runs.length > HISTORY_PREVIEW
      ? el(
          'button',
          {
            type: 'button',
            className: 'ghost',
            ariaExpanded: String(historyOpen),
            onclick: () => {
              historyOpen = !historyOpen
              box.classList.toggle('open', historyOpen)
              toggle.textContent = toggleText()
              toggle.ariaExpanded = String(historyOpen)
            }
          },
          toggleText()
        )
      : null
  const box = el(
    'div',
    { className: `stack run-history${historyOpen ? ' open' : ''}` },
    el('div', { className: 'row between history-head' }, el('h3', {}, `실행 이력 ${runs.length}`), toggle),
    ...[...runs]
      .reverse()
      .map((r) =>
        el('div', { className: 'muted' }, `${new Date(r.at).toLocaleString('ko-KR')} · ${label(r.agent)} · ${r.kind === 'resume' ? '재개' : '실행'}`)
      )
  )
  return box
}

detailDialog.addEventListener('close', flushMemo)

function renderDetail() {
  const project = projects.find((p) => p.key === detail?.key)
  const issue = project?.issues.find((i) => i.number === detail?.number)
  if (!project || !issue) return
  const update = (patch: Partial<Issue>) => {
    projects = patchIssue(projects, project.key, issue.number, patch)
    saveProjects()
    render()
    renderDetail()
  }
  detailDialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el(
          'div',
          { className: 'row' },
          el('span', { className: 'issue-id' }, issueId(project, issue)),
          el('span', { className: `status-chip status-${issue.status}` }, STATUSES.find((s) => s.value === issue.status)?.label)
        ),
        el(
          'button',
          { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: () => detailDialog.close() },
          '✕'
        )
      ),
      editingTitle && issue.status === 'done' ? titleEditor(issue.title, update) : titleView(issue),
      issue.description ? el('div', { className: 'description' }, issue.description) : null,
      el(
        'div',
        { className: 'images' },
        ...(issue.images ?? []).flatMap((name, i) => [
          el('div', { className: 'muted' }, imageToken(i + 1)),
          imageTag(name)
        ])
      ),
      issue.status === 'done' && resultOf(issue)
        ? el(
            'div',
            { className: 'row between' },
            el('h3', {}, '에이전트 결과'),
            el(
              'div',
              { className: 'row' },
              el(
                'button',
                {
                  type: 'button',
                  title: '새 세션에 이어서 작업할 수 있게 이슈와 결과를 복사',
                  onclick: (e: Event) => {
                    const btn = e.currentTarget as HTMLButtonElement
                    orca.plugin
                      .request('result.copy', { key: resultKey(issue), prompt: issuePrompt(project, issue) })
                      .then(() => {
                        btn.textContent = '복사됨'
                        setTimeout(() => (btn.textContent = '복사'), 1500)
                      })
                      .catch((err: Error) => {
                        saveError = `복사 실패: ${err.message}`
                        render()
                      })
                  }
                },
                '복사'
              ),
              el('button', { type: 'button', onclick: () =>
                  orca.plugin
                    .request('result.open', {
                      title: issueId(project, issue),
                      question: issuePrompt(project, issue),
                      key: resultKey(issue)
                    })
                    .catch((e: Error) => {
                      saveError = `결과 열기 실패: ${e.message}`
                      render()
                    })
              },
              '보기'
            )
            )
          )
        : null,
      issue.status === 'done' ? resumeButton(project, issue) : null,
      issue.status === 'done'
        ? field(
            '메모',
            el('textarea', {
              rows: 10,
              maxLength: 8000,
              placeholder: '이 이슈를 마치며 든 생각을 자유롭게 정리해 보세요',
              value: issue.memo ?? '',
              oninput: (e: any) => {
                projects = patchIssue(projects, project.key, issue.number, { memo: e.target.value })
                clearTimeout(memoTimer)
                memoTimer = setTimeout(flushMemo, 500)
              }
            })
          )
        : null,
      select('상태', STATUSES, issue.status, (status) => {
        projects = patchIssue(projects, project.key, issue.number, { status })
        detail = null
        saveProjects()
        detailDialog.close()
        render()
      }),
      el('div', { className: 'muted' }, `${new Date(issue.createdAt).toLocaleString('ko-KR')} 생성`),
      runHistory(issue),
      el('hr'),
      detailActions(project, issue)
    )
  )
}

type Batch = { project: Project; issues: Issue[]; busy: boolean; done: number; failed: string[]; finished: boolean }
let batch: Batch | null = null

function openBatch(project: Project) {
  batch = { project, issues: project.issues.filter((i) => i.status === 'todo'), busy: false, done: 0, failed: [], finished: false }
  renderBatch()
  dialog.showModal()
}

function closeBatch() {
  batch = null
  dialog.close()
}

// 이슈에 저장된 프로젝트, 에이전트, 실행 방식으로 차례대로 실행한다.
async function runBatch(current: Batch) {
  current.busy = true
  renderBatch()
  for (const issue of current.issues) {
    const id = issueId(current.project, issue)
    try {
      if (!issue.repoId) throw new Error('Orca 프로젝트가 지정되지 않았습니다.')
      // 기존 트리 방식은 개별 실행과 같이 프로젝트의 첫 작업 트리를 쓴다.
      let worktreeId: string | undefined
      if (issue.mode === 'existing') {
        const trees: Tree[] = await orca.plugin.request('worktrees.list', { repoId: issue.repoId })
        worktreeId = (trees.find((t) => t.id === issue.worktreeId) ?? trees[0])?.id
        if (!worktreeId) throw new Error('이 프로젝트에 작업 트리가 없습니다.')
      }
      const started = await orca.plugin.request(
        'issue.run',
        runRequest(current.project, issue, issue.repoId, issue.agent ?? AGENTS[0].value, worktreeId),
        { timeoutMs: 120000 }
      )
      projects = patchIssue(projects, current.project.key, issue.number, {
        status: 'in_progress',
        startedAt: Date.now(),
        ...(started.workspaceId ? { workspaceId: started.workspaceId } : {}),
        ...runsPatch(current.project.key, issue.number, issue.agent ?? AGENTS[0].value, 'run', started.workspaceId)
      })
      saveProjects()
    } catch (e) {
      current.failed.push(`${id}: ${(e as Error).message}`)
    }
    current.done++
    render()
    if (batch === current) renderBatch()
  }
  current.busy = false
  current.finished = true
  // 창은 이미 닫혔으니 실패는 패널 상단에 알린다.
  if (current.failed.length) saveError = `전체 실행 실패 ${current.failed.length}건: ${current.failed.join(' / ')}`
  render()
}

function renderBatch() {
  const current = batch
  if (!current) return
  const { project, issues, busy, finished, failed } = current
  dialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('h2', {}, '할 일 전체 실행'),
        el('button', { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: closeBatch }, '✕')
      ),
      el(
        'div',
        { className: 'confirm-body stack' },
        ...issues.map((i) =>
          el('div', { className: 'row' }, el('span', { className: 'issue-id' }, issueId(project, i)), i.title)
        )
      ),
      finished
        ? el('div', {}, `${issues.length - failed.length}개 실행, ${failed.length}개 실패`)
        : el(
            'div',
            { className: 'muted confirm-ask' },
            busy ? `실행 중 ${current.done}/${issues.length}` : `이슈 ${issues.length}개를 모두 실행하시겠습니까?`
          ),
      ...failed.map((f) => el('div', { className: 'error' }, f)),
      el(
        'div',
        { className: 'row confirm-actions' },
        el('button', { type: 'button', className: 'ghost', onclick: closeBatch }, finished || busy ? '닫기' : '취소'),
        finished
          ? null
          : el('button', { type: 'button', className: 'primary', disabled: busy, onclick: () => (closeBatch(), runBatch(current)) }, '실행')
      )
    )
  )
}

let issueQuery = ''
let issueSearchField = 'all'

// 여러 이슈를 골라 한꺼번에 삭제하거나 상태를 바꾸는 선택 모드.
let selectMode = false
const selected = new Set<number>()
let bulkDeleteAsk = false

function exitSelectMode() {
  selectMode = false
  bulkDeleteAsk = false
  selected.clear()
}

const currentProject = () => projects.find((p) => p.key === selectedKey) ?? projects[0]

function issueSearch(project: Project, box: HTMLElement) {
  const input = el('input', {
    type: 'search',
    value: issueQuery,
    placeholder: '이슈 검색',
    ariaLabel: '이슈 검색'
  }) as HTMLInputElement
  // 전체를 다시 그리면 입력란 포커스를 잃어서 목록만 바꾼다.
  input.oninput = () => {
    issueQuery = input.value
    box.replaceChildren(issueList(project))
  }
  const scope = el(
    'select',
    {
      ariaLabel: '검색 조건',
      style: 'width:auto;flex:none',
      onchange: () => {
        issueSearchField = scope.value
        box.replaceChildren(issueList(project))
      }
    },
    ...SEARCH_FIELDS.map((f) => el('option', { value: f.value }, f.label))
  ) as HTMLSelectElement
  scope.value = issueSearchField
  return el('div', { className: 'row' }, scope, el('div', { className: 'grow' }, input))
}

function issueList(project: Project) {
  if (project.issues.length === 0) {
    return el('div', { className: 'empty muted' }, '이슈가 없습니다. 새 이슈 버튼으로 등록하세요.')
  }
  // 검색 중에는 일치하는 이슈가 있는 그룹만 펼쳐 보여준다.
  const query = issueQuery.trim().toLowerCase()
  const matches = (i: Issue) => issueMatches(issueSearchField, query, issueId(project, i), i, resultOf(i))
  const groups = groupIssues(project)
    .map((g) => ({ ...g, issues: query ? g.issues.filter(matches) : g.issues }))
    .filter((g) => !query || g.issues.length > 0)
  if (groups.length === 0) return el('div', { className: 'empty muted' }, '검색 결과가 없습니다.')
  return el(
    'div',
    { className: 'stack issue-groups' },
    ...groups.map((group) =>
      el(
        'details',
        {
          open: query ? true : !collapsed.has(group.label),
          ontoggle: (e: any) => {
            if (query || e.target.open !== collapsed.has(group.label)) return
            if (e.target.open) collapsed.delete(group.label)
            else collapsed.add(group.label)
            saveSetting('collapsed', [...collapsed])
          }
        },
        el(
          'summary',
          { className: `row group-header status-${group.status}` },
          el('h3', {}, group.label),
          el('span', { className: 'badge' }, String(group.issues.length)),
          group.issues.some((i) => i.status === 'todo')
            ? el(
                'button',
                {
                  type: 'button',
                  className: 'icon run',
                  title: '할 일 전체 실행',
                  style: 'margin-left:auto',
                  onclick: (e: Event) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openBatch(project)
                  }
                },
                '▶ 전체 실행'
              )
            : null
        ),
        el('div', { className: 'group-body' }, ...group.issues.map((issue) => issueRow(project, issue)))
      )
    )
  )
}

// 가져온 백업 파일. 사용자가 확인하기 전에는 현재 데이터를 건드리지 않는다.
let pendingRestore: { projects: Project[]; results: Record<string, string> } | null = null

// 복구 전에 현재 상태를 백업 폴더에 남기고, 결과 키까지 통째로 바꾼다.
async function restoreBackup(data: { projects: Project[]; results: Record<string, string> }) {
  try {
    await orca.plugin.request('backup.auto', { reason: 'before-restore' })
    for (const k of (await orca.storage.keys()) as string[]) if (k.startsWith('result:')) await orca.storage.delete(k)
    results.clear()
    for (const [k, v] of Object.entries(data.results)) {
      await orca.storage.set(k, v)
      results.set(k, v)
    }
    projects = data.projects
    selectedKey = projects[0]?.key ?? ''
    saveSetting('selectedKey', selectedKey)
    saveProjects()
    saveError = ''
  } catch (e) {
    saveError = `복구 실패: ${(e as Error).message}`
  }
  pendingRestore = null
  selectMode = false
  selected.clear()
  render()
}

function importBackup() {
  const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      pendingRestore = parseBackup(await file.text())
      saveError = ''
    } catch (e) {
      pendingRestore = null
      saveError = `가져오기 실패: ${(e as Error).message}`
    }
    render()
  }
  input.click()
}

function banners() {
  const error = saveError ? el('div', { className: 'error' }, saveError) : null
  if (bulkDeleteAsk && selected.size > 0) {
    const project = currentProject()
    return el(
      'div',
      { className: 'stack' },
      error,
      el('div', {}, `선택한 이슈 ${selected.size}개를 삭제합니다. 되돌릴 수 없습니다.`),
      el(
        'div',
        { className: 'row' },
        el(
          'button',
          {
            type: 'button',
            className: 'danger solid',
            onclick: () => {
              const numbers = [...selected]
              dropResults(project.issues.filter((i) => selected.has(i.number)))
              projects = deleteIssues(projects, project.key, numbers)
              exitSelectMode()
              saveProjects()
              render()
            }
          },
          '삭제 확인'
        ),
        el('button', { type: 'button', className: 'ghost', onclick: () => ((bulkDeleteAsk = false), render()) }, '취소')
      )
    )
  }
  if (!pendingRestore) return error
  const issues = pendingRestore.projects.reduce((n, p) => n + p.issues.length, 0)
  return el(
    'div',
    { className: 'stack' },
    error,
    el('div', {}, `백업에서 프로젝트 ${pendingRestore.projects.length}개, 이슈 ${issues}개를 복구합니다. 현재 데이터는 모두 대체되며, 복구 직전 상태는 백업 폴더(${settings.backupDir || '~/.orca-issues/backups'})에 남깁니다.`),
    el(
      'div',
      { className: 'row' },
      el(
        'button',
        {
          type: 'button',
          className: 'primary',
          onclick: () => restoreBackup(pendingRestore!)
        },
        '복구 확인'
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'ghost',
          onclick: () => {
            pendingRestore = null
            render()
          }
        },
        '취소'
      )
    )
  )
}

function view() {
  const banner = banners()
  if (projects.length === 0) {
    return el(
      'div',
      { className: 'stack' },
      banner,
      el('div', { className: 'empty muted' }, '프로젝트가 없습니다. 프로젝트를 만들어 시작하세요.'),
      projectForm(false)
    )
  }
  const project = projects.find((p) => p.key === selectedKey) ?? projects[0]
  const listBox = el('div', { className: 'issue-scroll' }, issueList(project))
  return el(
    'div',
    { className: 'stack issue-view' },
    banner,
    el(
      'div',
      { className: 'row between' },
      el('h2', {}, '📁 프로젝트'),
      el(
        'div',
        { className: 'row' },
        el(
          'button',
          {
            type: 'button',
            className: 'ghost',
            title: '프로젝트 수정',
            ariaLabel: '프로젝트 수정',
            onclick: () => openProjectDialog(project)
          },
          '수정'
        ),
        el('button', { type: 'button', onclick: () => openProjectDialog(null) }, '+ 새 프로젝트')
      )
    ),
    select(
      '',
      projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })),
      project.key,
      (key) => {
        selectedKey = key
        issueQuery = ''
        exitSelectMode()
        saveSetting('selectedKey', key)
        app.querySelectorAll('.issue-groups > details').forEach((d) => (d.scrollTop = 0))
        render()
      }
    ),
    el('hr'),
    el(
      'div',
      { className: 'row between' },
      el('h2', {}, '📋 이슈'),
      el(
        'button',
        {
          type: 'button',
          className: 'primary',
          onclick: () => {
            renderIssueDialog(project)
            issueDialog.showModal()
            loadIssueRepos(project)
          }
        },
        '+ 새 이슈'
      )
    ),
    project.issues.length > 0 ? issueSearch(project, listBox) : null,
    listBox
  )
}

// 하단 버튼바에 들어갈 버튼. 기능을 추가할 때 여기에 { label, title, onclick }를 넣는다.
const BAR_ACTIONS: { label: string; title: string; onclick: () => void }[] = [
  {
    label: '☑ 선택',
    title: '이슈를 여러 개 골라 삭제하거나 상태를 바꿉니다',
    onclick: () => {
      if (projects.length === 0) return
      selectMode = true
      selected.clear()
      render()
    }
  },
  {
    label: '⬇ 백업',
    title: '프로젝트와 이슈 데이터를 JSON 파일로 저장',
    // ponytail: 이미지 첨부 파일은 포함하지 않는다(이슈에는 파일명만 저장돼 있다). 필요하면 worker에서 묶어 보낸다.
    onclick: () => {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
      orca.files
        .saveAs({
          suggestedName: `issues-backup-${stamp}.json`,
          mimeType: 'application/json',
          data: buildBackup(projects, Object.fromEntries(results), d)
        })
        .catch((e: Error) => {
          saveError = `백업 실패: ${e.message}`
          render()
        })
    }
  },
  { label: '⬆ 임포트', title: '백업 JSON 파일에서 프로젝트와 이슈 복구', onclick: importBackup }
]

// 선택 모드의 하단바: 전체 선택, 상태 변경, 삭제, 종료.
function selectBarItems() {
  const project = currentProject()
  const choosable = project.issues.filter((i) => i.status !== 'in_progress').map((i) => i.number)
  const status = el(
    'select',
    {
      title: '선택한 이슈의 상태를 바꿉니다',
      ariaLabel: '상태 변경',
      disabled: selected.size === 0,
      style: 'width:auto',
      onchange: (e: any) => {
        if (!e.target.value) return
        projects = setStatuses(projects, project.key, [...selected], e.target.value)
        exitSelectMode()
        saveProjects()
        render()
      }
    },
    el('option', { value: '' }, '상태 변경'),
    ...STATUSES.map((s) => el('option', { value: s.value }, s.label))
  )
  return [
    el(
      'button',
      {
        type: 'button',
        onclick: () => {
          if (selected.size === choosable.length) selected.clear()
          else choosable.forEach((n) => selected.add(n))
          bulkDeleteAsk = false
          render()
        }
      },
      selected.size === choosable.length && choosable.length > 0 ? '선택 해제' : '전체 선택'
    ),
    status,
    el(
      'button',
      { type: 'button', className: 'danger', disabled: selected.size === 0, onclick: () => ((bulkDeleteAsk = true), render()) },
      `삭제 (${selected.size})`
    ),
    el('button', { type: 'button', className: 'ghost', onclick: () => (exitSelectMode(), render()) }, '완료')
  ]
}

// '아이콘 글자' 형태의 라벨을 아이콘과 글자로 나눈다. 좁은 패널에서는 글자를 숨기고 아이콘만 보인다.
function barLabel(label: string) {
  const [icon, ...rest] = label.split(' ')
  return [el('span', { className: 'ico' }, icon), el('span', { className: 'lbl' }, rest.join(' '))]
}

async function openSettings() {
  try {
    defaultBackupDir = (await orca.plugin.request('backup.defaultDir', {})).dir
  } catch (e) {
    saveError = `설정 열기 실패: ${(e as Error).message}`
    return render()
  }
  settingsDraft = { ...settings, backupDir: settings.backupDir || defaultBackupDir }
  settingsError = ''
  pickingDir = false
  renderSettingsDialog()
  settingsDialog.showModal()
}

function pickBackupDir() {
  pickingDir = true
  settingsError = ''
  renderSettingsDialog()
  orca.plugin.request('backup.pickDir', { dir: settingsDraft.backupDir }).catch((e: Error) => {
    pickingDir = false
    settingsError = `폴더 선택 실패: ${e.message}`
    renderSettingsDialog()
  })
}

// worker가 폴더 선택 창의 결과를 남기면 사본에만 넣는다. 저장은 여전히 저장 버튼이 한다.
async function applyPickedDir() {
  const picked: { dir: string; error: string } | null = await orca.storage.get('pickedDir')
  if (!picked) return
  await orca.storage.delete('pickedDir')
  pickingDir = false
  if (picked.dir) settingsDraft.backupDir = picked.dir
  settingsError = picked.error
  if (settingsDialog.open) renderSettingsDialog()
}

async function saveSettings() {
  const dir = settingsDraft.backupDir.trim()
  const backupDir = dir === defaultBackupDir ? '' : dir
  savingSettings = true
  settingsError = ''
  renderSettingsDialog()
  try {
    if (backupDir) await orca.plugin.request('backup.checkDir', { dir: backupDir })
    // 확인하는 동안 창을 닫았으면 취소한 것이다.
    if (settingsDialog.open) {
      const next = parseSettings({ ...settingsDraft, backupDir })
      await orca.storage.set('settings', next)
      settings = next
      settingsDialog.close()
    }
  } catch (e) {
    settingsError = `저장 실패: ${(e as Error).message}`
  }
  savingSettings = false
  if (settingsDialog.open) renderSettingsDialog()
}

// 복구 직전 백업은 데이터 보호용이라 자동 백업을 꺼도 남긴다.
function backupSettings() {
  return [
    select(
      '자동 백업',
      [
        { value: 'on', label: '켜기' },
        { value: 'off', label: '끄기' }
      ],
      settingsDraft.autoBackup ? 'on' : 'off',
      (value) => (settingsDraft.autoBackup = value === 'on')
    ),
    field(
      '자동 백업 경로',
      el(
        'div',
        { className: 'row' },
        el(
          'div',
          { className: 'grow' },
          el('input', {
            value: settingsDraft.backupDir,
            placeholder: defaultBackupDir,
            spellcheck: false,
            oninput: (e: any) => (settingsDraft.backupDir = e.target.value)
          })
        ),
        el(
          'button',
          { type: 'button', disabled: pickingDir, style: 'white-space:nowrap', title: '폴더 선택 창을 엽니다', onclick: pickBackupDir },
          pickingDir ? '선택 중…' : '찾아보기'
        )
      )
    ),
    field(
      '자동 백업 보관 개수 (1~100)',
      el('input', {
        type: 'number',
        min: 1,
        max: 100,
        value: settingsDraft.backupKeep,
        oninput: (e: any) => (settingsDraft.backupKeep = e.target.value)
      })
    ),
    el('div', { className: 'muted' }, '경로를 비우면 기본 경로를 씁니다. 경로를 바꿔도 기존 백업은 옮기지 않습니다. 개수를 줄이면 다음 백업 때 오래된 파일부터 지웁니다.')
  ]
}

// 설정 탭. 항목을 늘릴 때 여기에 { label, body }를 넣는다. 저장과 취소는 모든 탭에 함께 적용된다.
const SETTINGS_TABS = [{ label: '자동 백업', body: backupSettings }]

function renderSettingsDialog() {
  settingsDialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('h2', {}, '설정'),
        el('button', { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: () => settingsDialog.close() }, '✕')
      ),
      el(
        'div',
        { className: 'tabs', role: 'tablist', ariaLabel: '설정 항목' },
        ...SETTINGS_TABS.map((tab, i) =>
          el(
            'button',
            {
              type: 'button',
              role: 'tab',
              ariaSelected: String(i === settingsTab),
              onclick: () => {
                settingsTab = i
                renderSettingsDialog()
              }
            },
            tab.label
          )
        )
      ),
      el('div', { className: 'stack', role: 'tabpanel', ariaLabel: SETTINGS_TABS[settingsTab].label }, ...SETTINGS_TABS[settingsTab].body()),
      settingsError ? el('div', { className: 'error' }, settingsError) : null,
      el(
        'div',
        { className: 'row' },
        el('button', { type: 'button', className: 'primary', disabled: savingSettings, onclick: saveSettings }, '저장'),
        el('button', { type: 'button', className: 'ghost', onclick: () => settingsDialog.close() }, '취소')
      )
    )
  )
}

function settingsButton() {
  return el(
    'button',
    {
      type: 'button',
      title: '설정',
      ariaLabel: '설정',
      onclick: openSettings
    },
    el('span', { className: 'ico' }, '⚙️')
  )
}

// 하단바 왼쪽에 고정하는 매뉴얼 버튼. 오른쪽 버튼들은 BAR_ACTIONS가 맡는다.
function manualButton() {
  return el(
    'button',
    {
      type: 'button',
      title: '이 플러그인의 사용 매뉴얼을 웹 브라우저로 엽니다',
      ariaLabel: '매뉴얼',
      style: 'margin-right:auto',
      onclick: () =>
        orca.plugin.request('manual.open', {}).catch((e: Error) => {
          saveError = `매뉴얼 열기 실패: ${e.message}`
          render()
        })
    },
    ...barLabel('📖 매뉴얼')
  )
}

function render() {
  document.getElementById('bar')!.replaceChildren(
    ...(selectMode && projects.length > 0
      ? selectBarItems()
      : [settingsButton(), manualButton(), ...BAR_ACTIONS.map((a) => el('button', { type: 'button', title: a.title, ariaLabel: a.label.split(' ').slice(1).join(' '), onclick: a.onclick }, ...barLabel(a.label)))])
  )
  // 목록을 새로 만들어도 그룹마다 보던 위치를 유지한다.
  const tops = [...app.querySelectorAll('.issue-groups > details')].map((d) => d.scrollTop)
  app.replaceChildren(view())
  app.querySelectorAll('.issue-groups > details').forEach((d, i) => (d.scrollTop = tops[i] ?? 0))
  renderDraftImages()
}

async function loadTrees(current: Run) {
  current.trees = null
  current.worktreeId = ''
  renderRun()
  const repoId = current.repoId
  try {
    const trees = await orca.plugin.request('worktrees.list', { repoId })
    if (run !== current || current.repoId !== repoId) return
    current.trees = trees
    current.worktreeId = (trees.find((t) => t.id === current.issue.worktreeId) ?? trees[0])?.id ?? ''
  } catch (e) {
    if (run !== current || current.repoId !== repoId) return
    current.trees = []
    current.error = (e as Error).message
  }
  renderRun()
}

async function openRun(project: Project, issue: Issue) {
  const current: Run = {
    project,
    issue,
    repos: null,
    repoId: '',
    trees: null,
    worktreeId: '',
    mode: issue.mode ?? 'new',
    confirmed: false,
    busy: false,
    error: ''
  }
  run = current
  if (issue.agent) lastAgent = issue.agent
  renderRun()
  dialog.showModal()
  try {
    const repos: Repo[] = await orca.plugin.request('repos.list')
    if (run !== current) return
    current.repos = repos
    current.repoId =
      (repos.find((r) => r.id === issue.repoId) ?? repos.find((r) => r.id === lastRepo) ?? repos[0])?.id ?? ''
    if (current.mode === 'existing' && current.repoId) return loadTrees(current)
  } catch (e) {
    if (run !== current) return
    current.repos = []
    current.error = (e as Error).message
  }
  renderRun()
}

function closeRun() {
  run = null
  dialog.close()
}

async function startRun(current: Run) {
  current.busy = true
  current.error = ''
  renderRun()
  lastRepo = current.repoId
  saveSetting('lastRepo', lastRepo)
  saveSetting('lastAgent', lastAgent)
  try {
    const started = await orca.plugin.request(
      'issue.run',
      runRequest(
        current.project,
        current.issue,
        current.repoId,
        lastAgent,
        current.mode === 'existing' ? current.worktreeId : undefined
      ),
      { timeoutMs: 120000 }
    )
    projects = patchIssue(projects, current.project.key, current.issue.number, {
      status: 'in_progress',
      startedAt: Date.now(),
      ...(started.workspaceId ? { workspaceId: started.workspaceId } : {}),
      ...runsPatch(current.project.key, current.issue.number, lastAgent, 'run', started.workspaceId)
    })
    saveProjects()
    render()
    if (run === current) closeRun()
  } catch (e) {
    current.busy = false
    current.error = (e as Error).message
    if (run === current) return renderRun()
    // 실행 중에 팝업을 닫았다면 오류를 패널에 보여준다.
    saveError = `${issueId(current.project, current.issue)} 실행 실패: ${current.error}`
    render()
  }
}

function radio(current: Run, value: Run['mode'], label: string) {
  return el(
    'label',
    { className: 'radio' },
    el('input', {
      type: 'radio',
      name: 'mode',
      value,
      checked: current.mode === value,
      disabled: current.busy,
      onchange: () => {
        current.mode = value
        current.error = ''
        if (value === 'existing') loadTrees(current)
        else renderRun()
      }
    }),
    label
  )
}

// 작업 내용을 보여주고 확인받는다. 프로젝트와 방식이 정해져 있으면 바로 실행하고, 아니면 설정 창으로 넘어간다.
function renderRunConfirm(current: Run) {
  const { project, issue } = current
  const go = () => {
    current.confirmed = true
    if (current.repoId && (current.mode === 'new' || current.worktreeId)) startRun(current)
    else renderRun()
  }
  dialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('span', { className: 'issue-id' }, issueId(project, issue)),
        el('button', { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: closeRun }, '✕')
      ),
      el('div', { className: 'confirm-title' }, issue.title),
      issue.description ? el('div', { className: 'description confirm-body' }, issue.description) : null,
      el(
        'div',
        { className: 'images' },
        ...(issue.images ?? []).flatMap((name, i) => [
          el('div', { className: 'muted' }, imageToken(i + 1)),
          imageTag(name)
        ])
      ),
      el(
        'div',
        { className: 'confirm-meta' },
        el('span', { className: 'muted' }, 'Orca 프로젝트'),
        el('span', {}, current.repos ? (current.repos.find((r) => r.id === current.repoId)?.name ?? '미지정') : '불러오는 중'),
        el('span', { className: 'muted' }, '에이전트'),
        el('span', {}, AGENTS.find((x) => x.value === lastAgent)?.label ?? lastAgent)
      ),
      el(
        'fieldset',
        {},
        el('legend', {}, '실행 방식'),
        radio(current, 'new', '새 트리로 실행'),
        radio(current, 'existing', '기존 트리로 실행')
      ),
      current.mode === 'existing'
        ? select(
            '작업 트리',
            (current.trees ?? []).map((t) => ({ value: t.id, label: t.name })),
            current.worktreeId,
            (id) => (current.worktreeId = id),
            false,
            current.trees ? '이 프로젝트에 작업 트리 없음' : '불러오는 중'
          )
        : null,
      el('div', { className: 'muted confirm-ask' }, '이 이슈로 작업을 실행하시겠습니까?'),
      el(
        'div',
        { className: 'row confirm-actions' },
        el('button', { type: 'button', className: 'ghost', onclick: closeRun }, '취소'),
        el(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: current.mode === 'existing' && !current.worktreeId,
            onclick: go
          },
          '실행'
        )
      )
    )
  )
}

function renderRun() {
  const current = run
  if (!current) return
  const { busy, repos, trees } = current
  const existing = current.mode === 'existing'
  if (!current.confirmed) return renderRunConfirm(current)
  dialog.replaceChildren(
    el(
      'div',
      { className: 'stack' },
      el(
        'div',
        { className: 'row between' },
        el('h2', {}, '작업 실행'),
        el(
          'button',
          { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: closeRun },
          '✕'
        )
      ),
      el('div', { className: 'description' }, `${issueId(current.project, current.issue)} ${current.issue.title}`),
      select(
        'Orca 프로젝트',
        (repos ?? []).map((r) => ({ value: r.id, label: r.name })),
        current.repoId,
        (id) => {
          current.repoId = id
          current.error = ''
          if (existing) loadTrees(current)
        },
        busy,
        repos ? '프로젝트 없음' : '불러오는 중'
      ),
      select(
        '에이전트',
        AGENTS,
        lastAgent,
        (agent) => (lastAgent = agent),
        busy
      ),
      el(
        'fieldset',
        {},
        el('legend', {}, '실행 방식'),
        radio(current, 'new', '새 트리로 실행'),
        radio(current, 'existing', '기존 트리로 실행')
      ),
      existing
        ? select(
            '작업 트리',
            (trees ?? []).map((t) => ({ value: t.id, label: t.name })),
            current.worktreeId,
            (id) => (current.worktreeId = id),
            busy,
            trees ? '이 프로젝트에 작업 트리 없음' : '불러오는 중'
          )
        : null,
      current.error ? el('div', { className: 'error' }, current.error) : null,
      el(
        'div',
        { className: 'row' },
        el(
          'button',
          {
            type: 'button',
            className: 'primary',
            disabled: busy || !current.repoId || (existing && !current.worktreeId),
            onclick: () => startRun(current)
          },
          busy ? '실행 중' : existing ? '기존 트리에서 실행' : '작업 트리 만들기'
        ),
        // 실행은 되돌릴 수 없어서, 실행 중에는 '닫기'로 표시한다. 닫아도 실행은 계속된다.
        el('button', { type: 'button', className: 'ghost', onclick: closeRun }, busy ? '닫기' : '취소')
      )
    )
  )
}

dialog.addEventListener('cancel', () => {
  run = null
  batch = null
})

async function boot() {
  try {
    const [saved, key, repo, agent, folded, stored] = await Promise.all(
      ['projects', 'selectedKey', 'lastRepo', 'lastAgent', 'collapsed', 'settings'].map((k) => orca.storage.get(k))
    )
    projects = saved ?? []
    settings = parseSettings(stored)
    // 결과는 이슈와 따로 저장돼 있어서 한꺼번에 읽어 둔다.
    const keys: string[] = await orca.storage.keys()
    await Promise.all(
      keys
        .filter((k) => k.startsWith('result:'))
        .map(async (k) => {
          const v = await orca.storage.get(k)
          if (typeof v === 'string') results.set(k, v)
        })
    )
    // 이전 형식(결과가 이슈 안에 있던 데이터)은 따로 옮기고 이슈에서는 뺀다.
    let migrated = false
    for (const p of projects) {
      for (const i of p.issues) {
        if (!i.result) continue
        if (!results.has(resultKey(i))) {
          results.set(resultKey(i), i.result)
          await orca.storage.set(resultKey(i), i.result)
        }
        migrated = true
      }
    }
    if (migrated) {
      projects = projects.map((p) => ({ ...p, issues: p.issues.map(({ result: _moved, ...issue }) => issue) }))
      saveProjects()
    }
    selectedKey = key ?? ''
    lastRepo = repo ?? ''
    lastAgent = agent ?? lastAgent
    collapsed = new Set(folded ?? DEFAULT_COLLAPSED)
    render()
    orca.storage.onDidChange(() => {
      applyCompleted().catch(() => {})
      applyPickedDir().catch(() => {})
    })
    applyCompleted().catch(() => {})
    refreshActive().catch(() => {})
    setInterval(() => refreshActive().catch(() => {}), 30_000)
  } catch (e) {
    // 빈 화면을 띄우면 다음 저장이 기존 데이터를 덮어쓴다. 오류만 보여주고 멈춘다.
    app.replaceChildren(el('div', { className: 'error' }, `불러오기 실패: ${(e as Error).message}`))
  }
}

boot()
