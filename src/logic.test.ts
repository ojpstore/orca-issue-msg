import { assert, test } from 'orca/testing'
import {
  addIssue,
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
  list = addIssue(list, 'ENG', { title: ' 첫 이슈 ', description: '', priority: 'none' }, 1)
  return addIssue(list, 'ENG', { title: '긴급 이슈', description: '첫 줄\n둘째 줄', priority: 'urgent' }, 2)
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

test('상태별로 묶고 우선순위순으로 정렬한다', () => {
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
  const list = addIssue(make([], '엔진', 'ENG'), 'ENG', { title: 'a', description: '', priority: 'none', images: ['x.png'] }, 1)
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

test('할 일 상태의 이슈만 실행할 수 있다', () => {
  const [project] = withIssues()
  const issue = project.issues[0]
  assert.equal(canRun(issue), true)
  for (const status of ['in_progress', 'done']) {
    assert.equal(canRun({ ...issue, status }), false)
  }
})

test('처음에는 할 일만 펼친다', () => {
  assert.deepEqual(DEFAULT_COLLAPSED, ['진행 중', '완료'])
})

test('프로젝트 수정은 이름만 바꾸고 키와 이슈를 유지한다', () => {
  const result = updateProject(withIssues(), 'ENG', ' 새 이름 ')
  const [project] = result.projects as Project[]
  assert.equal(result.key, 'ENG')
  assert.equal(project.name, '새 이름')
  assert.equal(project.key, 'ENG')
  assert.equal(project.nextNumber, 3)
  assert.equal(project.issues.length, 2)
})

test('프로젝트 수정은 빈 이름을 거부한다', () => {
  assert.ok(updateProject(withIssues(), 'ENG', ' ').error)
})

test('프로젝트를 삭제하면 그 프로젝트의 이슈도 모두 사라지고 다른 프로젝트는 남는다', () => {
  let list = make(withIssues(), '결제', 'PAY')
  list = addIssue(list, 'PAY', { title: '남는 이슈', description: '', priority: 'none' }, 3)
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
  const [next] = addIssue([project], 'ENG', { title: '새 이슈', description: '', priority: 'none' }, 3)
  assert.equal(next.issues[1].number, 3)
})
