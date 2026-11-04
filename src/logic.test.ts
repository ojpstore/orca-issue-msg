import { assert, test } from 'orca/testing'
import {
  addIssue,
  appendRun,
  buildBackup,
  cloneIssue,
  deleteIssues,
  handoffText,
  isBackupFile,
  parseBackup,
  parseSettings,
  resultKey,
  setStatuses,
  canRun,
  createProject,
  DEFAULT_COLLAPSED,
  deleteIssue,
  deleteProject,
  finalizeImages,
  groupIssues,
  patchIssue,
  runRequest,
  updateProject,
  type Project
} from './logic'

const make = (projects: Project[], name: string, key = '') => {
  const result = createProject(projects, name, key)
  assert.ok(result.projects, result.error)
  return result.projects as Project[]
}

const withIssues = () => {
  let list = make([], '엔진', 'eng')
  list = addIssue(list, 'ENG', { title: ' 첫 이슈 ', description: '' }, 1)
  return addIssue(list, 'ENG', { title: '긴급 이슈', description: '첫 줄\n둘째 줄' }, 2)
}

test('입력한 키는 대문자로 저장한다', () => {
  assert.equal(make([], '엔진', 'eng')[0].key, 'ENG')
})

test('이름이 없거나 키가 잘못됐거나 중복이면 거부한다', () => {
  assert.ok(createProject([], ' ', '').error)
  assert.ok(createProject([], '엔진', '1').error)
  assert.ok(createProject(make([], '엔진', 'ENG'), '또', 'ENG').error)
})

test('키를 비우면 이름에서 자동 생성하고 겹치면 번호를 붙인다', () => {
  let list: Project[] = []
  for (const name of ['Engine', 'Engine Two', '결제', '마지막']) list = make(list, name)
  assert.deepEqual(
    list.map((p) => p.key),
    ['ENG', 'ENG1', 'P1', 'P2']
  )
})

test('이슈 번호는 프로젝트별로 증가하고 제목을 다듬는다', () => {
  const [project] = withIssues()
  assert.equal(project.nextNumber, 3)
  assert.deepEqual(
    project.issues.map((i) => [i.number, i.title, i.status]),
    [
      [1, '첫 이슈', 'todo'],
      [2, '긴급 이슈', 'todo']
    ]
  )
})

test('할 일, 진행 중, 완료는 비어 있어도 보인다', () => {
  const [project] = withIssues()
  assert.deepEqual(
    groupIssues(project).map((g) => [g.label, g.issues.length]),
    [
      ['할 일', 2],
      ['진행 중', 0],
      ['완료', 0]
    ]
  )
})

test('상태별로 묶고 최신 번호순으로 정렬한다', () => {
  const list = patchIssue(withIssues(), 'ENG', 1, { status: 'done' })
  assert.deepEqual(
    groupIssues(list[0]).map((g) => [g.label, g.issues.map((i) => i.number)]),
    [
      ['할 일', [2]],
      ['진행 중', []],
      ['완료', [1]]
    ]
  )
  const [project] = withIssues()
  assert.deepEqual(
    groupIssues(project)[0].issues.map((i) => i.number),
    [2, 1]
  )
})

test('새 트리 요청에는 worktreeId 키가 없고 프롬프트는 줄바꿈을 유지한다', () => {
  const [project] = withIssues()
  const request = runRequest(project, project.issues[1], 'r1', 'claude')
  assert.deepEqual(request, {
    repoId: 'r1',
    agent: 'claude',
    name: 'ENG-2',
    prompt: 'ENG-2 긴급 이슈\n\n첫 줄\n둘째 줄',
    images: []
  })
  assert.equal('worktreeId' in request, false)
})

test('기존 트리 요청은 고른 작업 트리를 넘긴다', () => {
  const [project] = withIssues()
  assert.equal(runRequest(project, project.issues[0], 'r1', 'codex', 'r1::a').worktreeId, 'r1::a')
})

test('이슈의 이미지는 실행 요청으로 넘어가고 이전 이슈는 빈 목록이다', () => {
  const list = addIssue(make([], '엔진', 'ENG'), 'ENG', { title: 'a', description: '', images: ['x.png'] }, 1)
  const [project] = list
  assert.deepEqual(runRequest(project, project.issues[0], 'r1', 'claude').images, ['x.png'])
  const { images, ...old } = project.issues[0]
  assert.deepEqual(runRequest(project, old, 'r1', 'claude').images, [])
})

test('토큰이 지워진 이미지는 빼고 남은 토큰을 1부터 다시 매긴다', () => {
  const images = [
    { n: 1, name: 'a.png' },
    { n: 2, name: 'b.png' },
    { n: 3, name: 'c.png' }
  ]
  assert.deepEqual(finalizeImages('[Image #3] 버튼 수정, [Image #2] 참고', images), {
    description: '[Image #2] 버튼 수정, [Image #1] 참고',
    images: ['b.png', 'c.png']
  })
})

test('이미지와 연결되지 않은 토큰 문구는 그대로 둔다', () => {
  assert.deepEqual(finalizeImages('[Image #9] 설명', []), { description: '[Image #9] 설명', images: [] })
})

test('완료된 이슈는 실행할 수 없다', () => {
  const [project] = withIssues()
  const issue = project.issues[0]
  assert.equal(canRun(issue), true)
  assert.equal(canRun({ ...issue, status: 'in_progress' }), true)
  assert.equal(canRun({ ...issue, status: 'done' }), false)
})

test('처음에는 할 일만 펼친다', () => {
  assert.deepEqual(DEFAULT_COLLAPSED, ['진행 중', '완료'])
})

test('프로젝트 수정은 이름과 키를 바꾸고 이슈를 유지한다', () => {
  const result = updateProject(withIssues(), 'ENG', ' 새 이름 ', 'new')
  const [project] = result.projects as Project[]
  assert.equal(result.key, 'NEW')
  assert.equal(project.name, '새 이름')
  assert.equal(project.key, 'NEW')
  assert.equal(project.nextNumber, 3)
  assert.equal(project.issues.length, 2)
})

test('키를 비우거나 그대로 두면 기존 키를 유지한다', () => {
  assert.equal(updateProject(withIssues(), 'ENG', '이름', '').key, 'ENG')
  assert.equal(updateProject(withIssues(), 'ENG', '이름', 'ENG').key, 'ENG')
})

test('프로젝트 수정은 빈 이름, 잘못된 키, 다른 프로젝트의 키를 거부한다', () => {
  const list = make(withIssues(), '결제', 'PAY')
  assert.ok(updateProject(list, 'ENG', ' ', '').error)
  assert.ok(updateProject(list, 'ENG', '이름', '1').error)
  assert.ok(updateProject(list, 'ENG', '이름', 'PAY').error)
})

test('프로젝트를 삭제하면 그 프로젝트의 이슈도 모두 사라지고 다른 프로젝트는 남는다', () => {
  let list = make(withIssues(), '결제', 'PAY')
  list = addIssue(list, 'PAY', { title: '남는 이슈', description: '' }, 3)
  const left = deleteProject(list, 'ENG')
  assert.deepEqual(
    left.map((p) => p.key),
    ['PAY']
  )
  assert.deepEqual(
    left.flatMap((p) => p.issues.map((i) => i.title)),
    ['남는 이슈']
  )
})

test('이슈 삭제는 그 이슈만 지우고 번호는 다시 쓰지 않는다', () => {
  const [project] = deleteIssue(withIssues(), 'ENG', 2)
  assert.deepEqual(
    project.issues.map((i) => i.number),
    [1]
  )
  const [next] = addIssue([project], 'ENG', { title: '새 이슈', description: '' }, 3)
  assert.equal(next.issues[1].number, 3)
})

test('복제는 같은 내용의 할 일 이슈를 새 번호로 만들고 결과와 이력은 가져오지 않는다', () => {
  let list = withIssues()
  list = patchIssue(list, 'ENG', 1, { status: 'done', result: '결과', runs: [{ at: 1, agent: 'claude', kind: 'run' }] })
  const [project] = cloneIssue(list, 'ENG', 1, 9)
  const copy = project.issues[2]
  assert.equal(copy.number, 3)
  assert.equal(copy.status, 'todo')
  assert.equal(copy.title, '첫 이슈')
  assert.equal(copy.result, undefined)
  assert.equal(copy.runs, undefined)
})

test('여러 이슈 삭제와 상태 변경은 고른 번호에만 적용된다', () => {
  assert.deepEqual(deleteIssues(withIssues(), 'ENG', [1])[0].issues.map((i) => i.number), [2])
  assert.deepEqual(setStatuses(withIssues(), 'ENG', [2], 'done')[0].issues.map((i) => i.status), ['todo', 'done'])
})

test('실행 이력은 최근 20개만 남긴다', () => {
  const full = Array.from({ length: 20 }, (_, at) => ({ at, agent: 'claude', kind: 'run' as const }))
  const next = appendRun(full, { at: 99, agent: 'claude', kind: 'resume' })
  assert.equal(next.length, 20)
  assert.equal(next[19].at, 99)
  assert.equal(next[0].at, 1)
})

test('설정은 없거나 잘못된 값을 기본값과 범위로 맞춘다', () => {
  assert.deepEqual(parseSettings(null), { autoBackup: true, backupKeep: 10, backupDir: '' })
  assert.deepEqual(parseSettings({ autoBackup: false, backupKeep: '3', backupDir: ' D:/b ' }), { autoBackup: false, backupKeep: 3, backupDir: 'D:/b' })
  assert.equal(parseSettings({ backupKeep: 0 }).backupKeep, 10)
  assert.equal(parseSettings({ backupKeep: 'x' }).backupKeep, 10)
  assert.equal(parseSettings({ backupKeep: 500 }).backupKeep, 100)
})

test('백업 폴더 정리는 백업 이름 형식의 파일만 대상으로 한다', () => {
  assert.ok(isBackupFile('20261104-133256-auto.json'))
  assert.ok(isBackupFile('20261104-133256-before-restore.json'))
  assert.ok(!isBackupFile('package.json'))
  assert.ok(!isBackupFile('20261104-notes.json'))
})

test('백업은 결과를 이슈에 담고, 복구하면 다시 결과만 따로 나온다', () => {
  const list = withIssues()
  const results = { [resultKey(list[0].issues[0])]: '긴 결과' }
  const restored = parseBackup(buildBackup(list, results, new Date(0)))
  assert.deepEqual(restored.results, results)
  assert.equal(restored.projects[0].issues[0].result, undefined)
})

test('예전 형식 백업(결과가 이슈 안에 있는 파일)도 읽는다', () => {
  const list = patchIssue(withIssues(), 'ENG', 1, { result: '옛 결과' })
  const restored = parseBackup(JSON.stringify({ version: 1, projects: list }))
  assert.equal(restored.results[resultKey(list[0].issues[0])], '옛 결과')
  assert.throws(() => parseBackup('{"projects":3}'))
})

test('인계 문구는 결과를 최대 길이에서 자른다', () => {
  assert.ok(handoffText('ENG-1 제목', 'x'.repeat(10), 4).includes('xxxx…(이하 생략)'))
  assert.ok(handoffText('ENG-1 제목', '짧은 결과').includes('짧은 결과'))
})

test('저장소가 undefined를 거부하므로 만들거나 복제한 이슈에는 undefined 값이 없다', () => {
  const [made] = addIssue(make([], '엔진', 'eng'), 'ENG', { title: '새 트리', description: '', mode: 'new' }, 1)
  const [copy] = cloneIssue(withIssues(), 'ENG', 1, 9)
  for (const issue of [made.issues[0], copy.issues[2]]) {
    assert.deepEqual(issue, JSON.parse(JSON.stringify(issue)))
  }
})
