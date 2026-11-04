# Issues

Linear처럼 프로젝트와 이슈를 관리하고, 이슈 내용으로 Orca 작업을 실행하는 사이드바 패널입니다.

## 기능

- 프로젝트 등록, 수정, 삭제 (삭제하면 해당 이슈도 모두 삭제)
- 이슈 등록과 상세 보기, 상태(할 일, 진행 중, 완료)와 우선순위 변경
- 이슈 설명에 이미지 붙여넣기 (`[Image #1]` 토큰)
- `할 일` 이슈의 ▶ 버튼으로 새 작업 트리 또는 기존 작업 트리에서 에이전트 실행

## 데이터

- 프로젝트와 이슈: 플러그인 자체 저장소
- 첨부 이미지: `~/.orca-issues/images` (프로젝트를 삭제해도 파일은 남습니다)

## 권한

`trusted-worker`로 실행됩니다. 플러그인 API에 작업 트리 생성이 없어서 worker가 `orca` CLI를 호출하고, 이미지 파일을 저장합니다.

## 개발

```sh
orca plugin validate .
orca plugin dev watch .   # Orca에 불러와 로그와 리로드를 표시, Ctrl-C로 해제
```

## 테스트

```sh
orca plugin test .
orca plugin check .
```

Orca 1.4.247(Windows)에서는 플러그인 폴더가 Orca 설치 드라이브와 다르면 위 두 명령이 `cannot import "./orca-runtime.mjs"`로 실패합니다. 같은 드라이브(C:)에 복사해서 실행하세요.
