# Mosaic Desk

ChatGPT 계정으로 로그인한 Codex app-server와 Claude 계정으로 로그인한 Claude Code CLI를 한 화면에서 선택해 사용하는 macOS 데스크톱 앱입니다. 여러 Codex 계정을 연결하고 계정별 남은 사용량을 확인할 수 있으며, Codex 사용 한도 소진 시 남은 계정으로 요청을 다시 시도합니다. 대화 내용은 앱 창의 `localStorage`에 저장되고, Codex 대화는 연결된 계정의 Codex thread 기록에도 저장됩니다. 이메일·비밀번호, 세션 쿠키, API 키를 Mosaic Desk에 입력하지 않습니다.

## 데스크톱 앱 만들기

macOS Apple Silicon용 `.app`을 빌드하고 실행합니다.

```sh
npm install
npm run desktop:package
open "release/mac-arm64/Mosaic Desk.app"
```

개발 중에는 `npm run desktop`으로 앱 창을 실행할 수 있습니다. 앱은 저장된 대화가 재실행 후에도 유지되도록 전용 로컬 포트 `41743`에서 서버를 시작하고, 창을 닫을 때 함께 종료합니다. 별도 인스턴스를 격리해 실행할 때는 `MOSAIC_DESKTOP_PORT=41744 npm run desktop`처럼 포트를 바꿀 수 있습니다. 포트가 달라지면 브라우저 저장소도 분리됩니다. 이 빌드는 로컬 실행용이며 배포용 Apple 서명·공증은 포함하지 않습니다.

## 웹 개발 서버 실행

1. Node.js 20.3 이상을 준비합니다.
2. 사용할 공식 CLI를 설치합니다.

```bash
npm install -g @openai/codex
npm install -g @anthropic-ai/claude-code
```

3. Mosaic Desk 웹 개발 서버를 실행합니다.

```bash
npm start
```

4. 브라우저에서 [http://127.0.0.1:4173](http://127.0.0.1:4173)을 열고, 왼쪽 아래 연결 설정에서 계정 로그인을 누릅니다.

OpenAI 연결은 Codex app-server의 ChatGPT OAuth 흐름을 사용합니다. app-server가 계정 인증과 토큰 갱신을 관리하고, 계정 상태·Codex 한도·사용 가능한 모델을 조회합니다. Claude 연결은 `claude auth login --claudeai`로 Claude 구독 로그인 절차를 시작합니다.

의존성 설치가 필요 없습니다. 서버는 기본적으로 `127.0.0.1`에서만 대기합니다. 외부 네트워크에 공개하려면 별도의 인증·배포 보안 설계가 필요합니다.

## 포함된 기능

- OpenAI와 Claude 계정·모델 선택
- 응답 스트리밍, 대화 생성·전환·삭제
- Mosaic Desk 앱 창의 대화 기록 저장
- Projects 생성·이름 변경·삭제, 대화 배정·이동·해제 및 프로젝트 지침 적용
- ChatGPT·Claude 내보내기 ZIP/JSON에서 프로젝트, 텍스트 지침·자료와 대화 기록 가져오기
- Codex Fast 모드: 낮은 추론 단계를 사용하고 모델이 제공하는 경우 Fast 서비스 티어 요청
- 여러 Codex 계정의 ChatGPT OAuth 로그인, 계정별 모델·남은 사용 한도 조회 및 계정 선택
- 추가 Codex 계정 별칭 입력 및 로그인 이메일 표시
- OAuth 로그인 취소, Codex app-server 로그아웃, 추가 계정 프로필 삭제
- Claude Code CLI 로그아웃
- Codex app-server 기반 대화 thread 이어하기와 한도 초과 시 다른 계정으로 재시도
- Codex 대화별 읽기 전용 임시 작업 폴더와 사용자 MCP 서버 차단
- Claude Code CLI 로그인 상태 표시와 계정 오류 안내

기본 Codex 계정은 같은 컴퓨터의 Codex CLI와 인증 상태 및 thread 기록을 공유합니다. 추가 계정은 macOS의 앱 데이터 폴더 아래 계정별 `CODEX_HOME`으로 격리하며, 인증 파일을 복사하지 않습니다. 각 Codex 계정의 app-server가 제공하는 사용 한도 창의 남은 비율과 재설정 시각을 표시합니다. 사용 한도 초과가 app-server 응답에서 확인되면 남은 한도가 있는 연결 계정에서 같은 대화 내용을 새 thread로 재시도합니다. 인증 실패, 네트워크 오류, 모델 사용 불가 오류는 계정을 바꾸어 재시도하지 않습니다. Claude Code CLI는 로그인 상태를 확인하며, 플랜 사용량은 Claude Code 내부에서 `/usage`를 실행해 확인해야 합니다. Codex app-server의 프로토콜 상태와 호환성은 [공식 문서](https://learn.chatgpt.com/docs/app-server)를 확인해 주세요. Mosaic에서 Codex 대화를 삭제하면 해당 계정의 app-server thread 기록도 삭제됩니다.

Projects는 대화와 프로젝트 지침을 앱 창의 `localStorage`에 저장합니다. 사이드바의 아래 화살표에서 ChatGPT 또는 Claude 계정 설정의 데이터 내보내기로 받은 ZIP이나 JSON 파일을 고르면 파일을 이 Mac에서 읽고, 가져오기 전에 서비스와 자료 수를 확인합니다. 가져온 프로젝트 지침과 텍스트 자료는 이후 응답 문맥에 포함되며, 대화는 원본 서비스 ID를 사용해 반복 가져오기에서 중복을 건너뜁니다. 첨부 파일 바이너리는 가져오지 않습니다. 현재 로컬 저장 방식에 맞춰 파일은 256MB, 개별 JSON은 64MB, ZIP 안의 JSON 총량은 128MB 이하로 제한하고, 기존 대화를 포함한 앱 저장 데이터가 약 3.8MB를 넘을 것으로 예상되면 저장하지 않습니다. ChatGPT 내보내기에 원래 Projects 정보가 포함되지 않은 경우 해당 대화는 가져오기 프로젝트로 묶입니다.

Codex Fast 토글은 모델이 지원하는 경우 낮은 추론 단계를 적용합니다. 모델 목록에서 Fast 서비스 티어를 제공한다고 알리는 경우에만 그 티어도 요청합니다. 티어 정보가 없는 모델은 낮은 추론 단계만 사용하며, 이 앱은 서버가 실제로 처리한 속도 티어의 별도 확인 신호를 제공하지 않습니다. Claude에서는 Fast 토글을 사용하지 않습니다. 프로젝트를 삭제해도 해당 대화는 보존되고 ‘모든 대화’로 이동합니다. Codex 연결 해제는 app-server의 `account/logout`을 사용하며, 기본 계정은 `~/.codex`를 공유하므로 Codex CLI에서도 로그아웃됩니다. 추가 계정을 삭제하면 해당 `CODEX_HOME`의 인증 정보와 Codex 세션 기록이 제거됩니다. Mosaic 대화 본문은 남고 다음 응답은 다른 계정에 대화 내용으로 이어집니다. Claude 연결 해제는 Claude Code CLI의 `auth logout`을 실행합니다. 진행 중인 Codex 응답은 계정 삭제나 연결 해제를 막습니다.
