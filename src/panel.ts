import {
  addIssue,
  AGENTS,
  canRun,
  createProject,
  DEFAULT_COLLAPSED,
  deleteProject,
  finalizeImages,
  groupIssues,
  imageToken,
  issueId,
  patchIssue,
  PRIORITIES,
  priorityLabel,
  runRequest,
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
  busy: boolean
  error: string
}

const app = document.getElementById('app') as HTMLElement
const dialog = document.getElementById('run') as HTMLDialogElement
const projectDialog = document.getElementById('project') as HTMLDialogElement
const issueDialog = document.getElementById('issue') as HTMLDialogElement
const detailDialog = document.getElementById('detail') as HTMLDialogElement

let projects: Project[] = []
let selectedKey = ''
let lastRepo = ''
let lastAgent = AGENTS[0].value
let saveError = ''
let projectError = ''
let editingKey: string | null = null
let confirmingDelete = false
let run: Run | null = null
let detail: { key: string; number: number } | null = null
let collapsed = new Set<string>()
const projectDraft = { name: '', key: '' }
const issueDraft = {
  title: '',
  description: '',
  priority: 'none',
  images: [] as { n: number; name: string }[],
  nextImage: 1
}
const imageUrls = new Map<string, string>()
let draftImages: HTMLElement | null = null
let draftDescription: HTMLTextAreaElement | null = null
let imageError = ''
let uploading = 0

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

async function uploadImage(file: File) {
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

function readAsDataUrl(file: File) {
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

function saveProjects() {
  orca.storage.set('projects', projects).catch((e: Error) => {
    saveError = `저장 실패: ${e.message}`
    render()
  })
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
  issueDraft.priority = 'none'
  issueDraft.images = []
  issueDraft.nextImage = 1
  imageError = ''
}

// ✕와 Esc는 작성 중인 내용을 남긴다. 실수로 닫아도 잃지 않도록, 지우는 건 취소뿐이다.
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
        rows: 3,
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
    select('우선순위', PRIORITIES, issueDraft.priority, (value) => (issueDraft.priority = value)),
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
  return el(
    'div',
    { className: 'row issue-card' },
    el(
      'button',
      {
        type: 'button',
        className: 'issue-open',
        title: '이슈 보기',
        onclick: () => openDetail(project.key, issue.number)
      },
      el('span', { className: 'issue-id' }, id),
      el('span', { className: 'issue-title' }, issue.title),
      issue.priority === 'none' ? null : el('span', { className: 'muted' }, priorityLabel(issue))
    ),
    canRun(issue)
      ? el(
          'button',
          {
            type: 'button',
            className: 'icon',
            title: '작업 실행',
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
  renderDetail()
  detailDialog.showModal()
}

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
        el('h2', {}, issueId(project, issue)),
        el(
          'button',
          { type: 'button', className: 'ghost icon', ariaLabel: '닫기', onclick: () => detailDialog.close() },
          '✕'
        )
      ),
      el('div', { className: 'description detail-title' }, issue.title),
      issue.description ? el('div', { className: 'description' }, issue.description) : null,
      el(
        'div',
        { className: 'images' },
        ...(issue.images ?? []).flatMap((name, i) => [
          el('div', { className: 'muted' }, imageToken(i + 1)),
          imageTag(name)
        ])
      ),
      select('상태', STATUSES, issue.status, (status) => update({ status })),
      select('우선순위', PRIORITIES, issue.priority, (priority) => update({ priority })),
      el('div', { className: 'muted' }, `${new Date(issue.createdAt).toLocaleString('ko-KR')} 생성`)
    )
  )
}

function issueList(project: Project) {
  if (project.issues.length === 0) {
    return el('div', { className: 'empty muted' }, '이슈가 없습니다. 새 이슈 버튼으로 등록하세요.')
  }
  return el(
    'div',
    { className: 'stack' },
    ...groupIssues(project).map((group) =>
      el(
        'details',
        {
          open: !collapsed.has(group.label),
          ontoggle: (e: any) => {
            if (e.target.open !== collapsed.has(group.label)) return
            if (e.target.open) collapsed.delete(group.label)
            else collapsed.add(group.label)
            saveSetting('collapsed', [...collapsed])
          }
        },
        el(
          'summary',
          { className: 'row group-header' },
          el('h3', {}, group.label),
          el('span', { className: 'badge' }, String(group.issues.length))
        ),
        el('div', { className: 'group-body' }, ...group.issues.map((issue) => issueRow(project, issue)))
      )
    )
  )
}

function view() {
  const banner = saveError ? el('div', { className: 'error' }, saveError) : null
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
  return el(
    'div',
    { className: 'stack' },
    banner,
    el(
      'div',
      { className: 'row end' },
      el(
        'div',
        { className: 'grow' },
        select(
          '프로젝트',
          projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` })),
          project.key,
          (key) => {
            selectedKey = key
            saveSetting('selectedKey', key)
            render()
          }
        )
      ),
      el(
        'button',
        {
          type: 'button',
          title: '프로젝트 수정',
          ariaLabel: '프로젝트 수정',
          onclick: () => openProjectDialog(project)
        },
        '수정'
      ),
      el('button', { type: 'button', onclick: () => openProjectDialog(null) }, '+ 새 프로젝트')
    ),
    el('hr'),
    el(
      'div',
      { className: 'row between' },
      el('h2', {}, '이슈'),
      el(
        'button',
        {
          type: 'button',
          onclick: () => {
            renderIssueDialog(project)
            issueDialog.showModal()
          }
        },
        '+ 새 이슈'
      )
    ),
    issueList(project)
  )
}

function render() {
  app.replaceChildren(view())
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
    current.worktreeId = trees[0]?.id ?? ''
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
    mode: 'new',
    busy: false,
    error: ''
  }
  run = current
  renderRun()
  dialog.showModal()
  try {
    const repos: Repo[] = await orca.plugin.request('repos.list')
    if (run !== current) return
    current.repos = repos
    current.repoId = (repos.find((r) => r.id === lastRepo) ?? repos[0])?.id ?? ''
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
    await orca.plugin.request(
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

function renderRun() {
  const current = run
  if (!current) return
  const { busy, repos, trees } = current
  const existing = current.mode === 'existing'
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
        repos ? 'Git 프로젝트 없음' : '불러오는 중'
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
})

async function boot() {
  try {
    const [saved, key, repo, agent, folded] = await Promise.all(
      ['projects', 'selectedKey', 'lastRepo', 'lastAgent', 'collapsed'].map((k) => orca.storage.get(k))
    )
    projects = saved ?? []
    selectedKey = key ?? ''
    lastRepo = repo ?? ''
    lastAgent = agent ?? lastAgent
    collapsed = new Set(folded ?? DEFAULT_COLLAPSED)
    render()
  } catch (e) {
    // 빈 화면을 띄우면 다음 저장이 기존 데이터를 덮어쓴다. 오류만 보여주고 멈춘다.
    app.replaceChildren(el('div', { className: 'error' }, `불러오기 실패: ${(e as Error).message}`))
  }
}

boot()
