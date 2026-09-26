# Mosaic AI

ChatGPT 계정으로 로그인한 Codex app-server와 Claude 계정으로 로그인한 Claude Code CLI를 한 화면에서 선택해 사용하는 로컬 웹 채팅 MVP입니다. 대화 내용은 브라우저의 `localStorage`에 저장되고, Codex 대화는 Codex의 thread 기록에도 저장됩니다. 이메일·비밀번호, 세션 쿠키, API 키를 Mosaic에 입력하지 않습니다.

## 실행

1. Node.js 20.3 이상을 준비합니다.
2. 사용할 공식 CLI를 설치합니다.

```bash
npm install -g @openai/codex
npm install -g @anthropic-ai/claude-code
```

3. Mosaic를 실행합니다.

```bash
npm start
```

4. 브라우저에서 [http://127.0.0.1:4173](http://127.0.0.1:4173)을 열고, 왼쪽 아래 연결 설정에서 계정 로그인을 누릅니다.

OpenAI 연결은 Codex app-server의 ChatGPT OAuth 흐름을 사용합니다. app-server가 계정 인증과 토큰 갱신을 관리하고, 계정 상태·Codex 한도·사용 가능한 모델을 조회합니다. Claude 연결은 `claude auth login --claudeai`로 Claude 구독 로그인 절차를 시작합니다.

의존성 설치가 필요 없습니다. 서버는 기본적으로 `127.0.0.1`에서만 대기합니다. 외부 네트워크에 공개하려면 별도의 인증·배포 보안 설계가 필요합니다.

## 포함된 기능

- OpenAI와 Claude 계정·모델 선택
- 응답 스트리밍, 대화 생성·전환·삭제
- 브라우저 내 대화 기록 저장
- Codex app-server 기반 ChatGPT 로그인, 대화 thread 이어하기, 모델·사용량 상태 조회
- Codex 대화별 읽기 전용 임시 작업 폴더와 사용자 MCP 서버 차단
- Claude Code CLI 로그인 상태 표시와 계정 오류 안내

계정 연결은 제공자마다 한 개씩 지원합니다. Codex 로그인은 같은 컴퓨터의 Codex CLI와 인증 상태를 공유합니다. 사용량은 해당 구독 계정의 공식 한도를 따르며, 계정 간 자동 전환·파일 업로드·웹 검색 도구는 포함하지 않았습니다. Mosaic에서 Codex 대화를 삭제하면 해당 app-server thread 기록도 삭제됩니다.
