// 패널과 worker가 함께 쓰는 요청 계약.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** 작업 트리를 만들 수 있는 Orca Git 프로젝트 목록. */
    'repos.list': { output: { id: string; name: string }[] }
    /** 프로젝트의 기존 작업 트리 목록. */
    'worktrees.list': {
      input: { repoId: string }
      output: { id: string; name: string; repoId: string }[]
    }
    /** 이슈 내용을 프롬프트로 에이전트를 실행한다. worktreeId가 없으면 새 작업 트리를 만든다. */
    'issue.run': {
      input: {
        repoId: string
        worktreeId?: string
        agent: string
        name: string
        prompt: string
        images: string[]
      }
      output: { ok: true }
    }
    // Orca는 패널과 worker 사이 메시지를 약 48KB로 제한해서 이미지를 조각으로 주고받는다.
    /** 빈 이미지 파일을 만들고 파일 이름을 돌려준다. */
    'image.start': { input: { type: string }; output: { name: string } }
    /** base64 조각을 파일 끝에 덧붙인다. */
    'image.append': { input: { name: string; data: string }; output: { ok: true } }
    /** offset 위치의 base64 조각과 파일 전체 크기를 돌려준다. */
    'image.read': {
      input: { name: string; offset: number }
      output: { type: string; data: string; size: number }
    }
  }
}
