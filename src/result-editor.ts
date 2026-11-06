// '보기'가 만든 .issue-result 파일을 읽기 전용으로 보여주는 custom editor.
// 편집기 프레임에는 네트워크가 없어서 marked와 DOMPurify를 src/vendor에 복사해 쓴다.
import { marked } from './vendor/marked.js'
import DOMPurify from './vendor/purify.js'

type Result = { title: string; question: string; text: string }

const style = document.createElement('style')
style.textContent = `
body{margin:0;color:var(--orca-foreground);background:var(--orca-background)}
main{max-width:960px;margin:0 auto;padding:24px 20px;font:15px/1.7 system-ui,sans-serif}
h1{font-size:18px}
h2.label{margin:24px 0 8px;font-size:14px;color:var(--orca-muted-foreground)}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
.q,pre code{display:block;padding:12px;background:var(--orca-muted);border-radius:var(--orca-radius)}
.q{margin:0;font:inherit;white-space:pre-wrap}
table{border-collapse:collapse}
th,td{padding:6px 12px;border:1px solid var(--orca-border)}
a{color:var(--orca-primary)}
hr{border:0;border-top:1px solid var(--orca-border)}
img{max-width:100%}`
const main = document.createElement('main')
document.head.append(style)
document.body.append(main)

function render({ title, question, text }: Result) {
  const heading = document.createElement('h1')
  heading.textContent = `${title} 에이전트 결과`
  const label = (value: string) => {
    const h = document.createElement('h2')
    h.className = 'label'
    h.textContent = value
    return h
  }
  const q = document.createElement('pre')
  q.className = 'q'
  q.textContent = question
  const answer = document.createElement('div')
  answer.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }))
  main.replaceChildren(heading, label('질문'), q, label('답변'), answer)
}

// 프레임이 링크로 이동해 버리면 결과 화면이 사라지므로 기본 브라우저로 넘긴다.
document.addEventListener('click', (e) => {
  const link = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null
  if (!link) return
  e.preventDefault()
  if (/^(https?:|mailto:)/.test(link.href)) void orca.shell.openExternal(link.href)
})

const doc = await orca.document!.session<Result>({
  decode: (content) => JSON.parse(content.kind === 'text' ? content.text : '{}'),
  encode: (value) => ({ kind: 'text', text: JSON.stringify(value) })
})
render(doc.value)
doc.onReplace(render)
