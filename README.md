# Mosaic Desk

ChatGPT Desktop처럼 채팅을 중심으로 화면을 구성한 macOS 데스크톱 앱입니다. ChatGPT 계정으로 로그인한 Codex app-server, Claude Code CLI, API로 연결한 에이전트의 모델을 하나의 목록에서 선택합니다. 여러 Codex 계정을 연결하고 계정별 남은 사용량을 확인할 수 있으며, Codex 사용 한도 소진 시 남은 계정으로 요청을 다시 시도합니다. 대화 내용은 앱 창의 `localStorage`에 저장되고, Codex 대화는 연결된 계정의 Codex thread 기록에도 저장됩니다. 공식 OpenAI 또는 Anthropic 앱은 아닙니다.

## API 에이전트 연결

1. 사이드바의 **에이전트 +** 또는 **설정 및 연결 → API 에이전트 → 에이전트 추가**를 엽니다.
2. DeepSeek, OpenAI API 또는 직접 입력을 선택하고, 이름·API 기본 주소·키를 입력합니다.
3. **연결 및 모델 가져오기**를 누르면 `/models`를 조회합니다. 성공한 연결의 모델이 화면 왼쪽 위 **모델 선택** 목록에 바로 나타납니다.
4. 목록에서 모델을 고르고 메시지를 보냅니다. 별도의 서비스 선택 단계는 없습니다. 같은 모델 이름도 연결별로 구분됩니다.

DeepSeek 기본 주소는 `https://api.deepseek.com`, OpenAI는 `https://api.openai.com/v1`입니다. 사용자 지정 서비스는 Bearer API 키, `GET /models`, `POST /chat/completions`와 SSE 스트리밍을 제공하는 OpenAI 호환 API를 지원합니다. 기본 주소에는 `/models`나 `/chat/completions`를 붙이지 않습니다. HTTPS를 사용하며 localhost만 HTTP를 허용합니다. 모델 목록에 포함되어 있어도 일부 모델은 Chat Completions를 지원하지 않을 수 있습니다. 그런 모델은 응답 시 지원 여부를 확인하는 오류가 표시됩니다. API 에이전트는 텍스트 대화와 프로젝트 지침을 지원하며 도구 실행은 제공하지 않습니다.

키는 대화 기록이나 브라우저 `localStorage`에 저장하지 않습니다. 데스크톱에서는 Electron `safeStorage`와 macOS 키체인으로 암호화하여 앱 데이터 폴더의 `api-connections.json`에 저장합니다. 서명되지 않은 로컬 빌드는 업데이트 시 키체인 접근을 다시 요청할 수 있습니다. 웹 개발 서버는 키를 메모리에만 보관하므로 서버 재시작 후 다시 입력해야 합니다. API 사용료는 각 서비스의 API 계정에 청구되며 구독 계정 한도와 별개입니다.

API 연결은 편집·모델 새로고침·연결 해제·삭제가 가능합니다. 연결 해제는 이 앱에서 키를 제거하며 서비스 측 키 자체를 폐기하지 않습니다. 삭제해도 대화 본문은 남고, 다음 응답에는 사용자가 다른 모델을 선택해야 합니다. API 주소를 바꿀 때는 새로운 키를 입력해야 하며, 응답 중인 연결은 편집하거나 삭제할 수 없습니다. API 오류에 대한 자동 재시도나 다른 API 계정으로의 자동 전환은 하지 않습니다.

## 기존 대화 선택 가져오기

1. 사이드바의 **대화 가져오기**를 누르고 **Codex** 또는 **Claude Code**를 선택합니다. Codex는 가져올 로컬 계정도 선택할 수 있습니다.
2. 기본 목록은 앱·IDE 기록을 표시합니다. **CLI 대화 포함**, **출처 불명 포함**을 각각 켜서 필요한 기록만 추가하고, Codex의 보관된 기록도 따로 조회할 수 있습니다. 필터를 바꾸면 기존 선택은 해제됩니다.
3. 제목으로 검색하고 대화 제목을 눌러 본문을 미리 봅니다. 원하는 항목을 체크한 뒤 **선택한 대화 가져오기**를 누릅니다. 프로젝트를 지정하거나 ‘프로젝트 미지정’으로 저장할 수 있습니다.
4. 가져온 대화를 열고 모델 선택기로 Codex·Claude·API 모델 중 원하는 모델을 골라 이어갑니다. 이미 가져온 대화는 중복 저장하지 않습니다.

가져오기는 선택 시점의 사용자·AI 텍스트를 Mosaic에 복사하는 방식입니다. 원본 대화와 양방향 동기화하지 않으며, 가져온 대화를 삭제해도 원본 기록은 삭제되지 않습니다. 도구 실행 결과, 내부 추론, 첨부 파일은 가져오지 않습니다. 전체 텍스트는 로컬에 보관하고, 이어지는 응답에는 최근 최대 60개 메시지를 요청 크기 한도 안에서 전달합니다. 문맥을 줄이면 화면에 안내합니다.

Codex는 공식 [app-server의 thread/list·thread/read](https://learn.chatgpt.com/docs/app-server)를 사용하며 서버가 기록한 source와 originator로 출처를 구분합니다. Claude Code는 공식 [로컬 transcript 저장 경로](https://code.claude.com/docs/en/claude-directory)의 `~/.claude/projects/*/*.jsonl`을 읽습니다. `CLAUDE_CONFIG_DIR`가 설정되어 있으면 해당 폴더를 사용합니다. entrypoint가 없는 기록은 ‘출처 불명’으로 분류합니다. 다른 컴퓨터나 클라우드에만 저장된 대화는 이 목록에 나타나지 않습니다. Claude의 클라우드 대화와 ChatGPT 대화는 **내보내기 파일 선택**에서 ZIP/JSON을 연 뒤 가져올 대화를 체크하세요.

Claude 로컬 파일은 64MB까지 읽으며 목록은 최대 5,000개 파일을 탐색합니다. 읽기 실패와 목록 제한은 화면에 표시합니다. 가져올 텍스트와 기존 저장 데이터가 앱의 로컬 저장 한도를 넘으면 저장하지 않고 선택 개수를 줄이도록 안내합니다.

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

- ChatGPT Desktop 스타일의 채팅 화면·접을 수 있는 에이전트 목록·macOS 통합 타이틀바
- Codex·Claude·API 모델을 통합한 검색 가능한 모델 선택기
- DeepSeek·OpenAI·사용자 지정 OpenAI 호환 API 에이전트 추가 및 모델 자동 조회
- API 에이전트 편집·모델 새로고침·연결 해제·삭제 및 API 키 암호화 보관
- 응답 스트리밍, 대화 생성·전환·삭제
- Mosaic Desk 앱 창의 대화 기록 저장
- Projects 생성·이름 변경·삭제, 대화 배정·이동·해제 및 프로젝트 지침 적용
- ChatGPT·Claude 내보내기 ZIP/JSON에서 프로젝트, 텍스트 지침·자료와 대화 기록 가져오기
- Codex 추론 강도: 입력창 Fast 옆과 모델 선택 메뉴에서 High·XHigh 등 모델이 지원하는 강도를 선택하고 다음 실행에도 유지
- Codex Fast 모드: 직접 선택한 추론 강도를 유지하며 지원되는 Fast 서비스 티어 요청. 자동 선택에서는 Low 우선 적용
- 여러 Codex 계정의 ChatGPT OAuth 로그인, 계정별 모델·남은 사용 한도 조회 및 계정 선택
- 추가 Codex 계정 별칭 입력 및 로그인 이메일 표시
- OAuth 로그인 취소, Codex app-server 로그아웃, 추가 계정 프로필 삭제
- Claude Code CLI 로그아웃
- Codex app-server 기반 대화 thread 이어하기와 한도 초과 시 다른 계정으로 재시도
- Codex 대화별 읽기 전용 임시 작업 폴더와 사용자 MCP 서버 차단
- Claude Code CLI 로그인 상태 표시와 계정 오류 안내

기본 Codex 계정은 같은 컴퓨터의 Codex CLI와 인증 상태 및 thread 기록을 공유합니다. 추가 계정은 macOS의 앱 데이터 폴더 아래 계정별 `CODEX_HOME`으로 격리하며, 인증 파일을 복사하지 않습니다. 각 Codex 계정의 app-server가 제공하는 사용 한도 창의 남은 비율과 재설정 시각을 표시합니다. 사용 한도 초과가 app-server 응답에서 확인되면 남은 한도가 있는 연결 계정에서 같은 대화 내용을 새 thread로 재시도합니다. 인증 실패, 네트워크 오류, 모델 사용 불가 오류는 계정을 바꾸어 재시도하지 않습니다. Claude Code CLI는 로그인 상태를 확인하며, 플랜 사용량은 Claude Code 내부에서 `/usage`를 실행해 확인해야 합니다. Codex app-server의 프로토콜 상태와 호환성은 [공식 문서](https://learn.chatgpt.com/docs/app-server)를 확인해 주세요. Mosaic에서 Codex 대화를 삭제하면 해당 계정의 app-server thread 기록도 삭제됩니다.

Projects는 대화와 프로젝트 지침을 앱 창의 `localStorage`에 저장합니다. 사이드바의 아래 화살표에서 ChatGPT 또는 Claude 계정 설정의 데이터 내보내기로 받은 ZIP이나 JSON 파일을 고르면 파일을 이 Mac에서 읽고, 가져오기 전에 서비스와 자료 수를 확인합니다. 가져온 프로젝트 지침과 텍스트 자료는 이후 응답 문맥에 포함되며, 대화는 원본 서비스 ID를 사용해 반복 가져오기에서 중복을 건너뜁니다. 첨부 파일 바이너리는 가져오지 않습니다. 현재 로컬 저장 방식에 맞춰 파일은 256MB, 개별 JSON은 64MB, ZIP 안의 JSON 총량은 128MB 이하로 제한하고, 기존 대화를 포함한 앱 저장 데이터가 약 3.8MB를 넘을 것으로 예상되면 저장하지 않습니다. ChatGPT 내보내기에 원래 Projects 정보가 포함되지 않은 경우 해당 대화는 가져오기 프로젝트로 묶입니다.

입력창 하단의 **Fast 옆 추론 선택기**에서 현재 강도를 보고 High·XHigh 등으로 바로 변경할 수 있습니다. 상단 모델 메뉴의 추론 강도와 같은 설정을 공유합니다. 옵션은 연결 계정의 `model/list.supportedReasoningEfforts`를 따르며, 선택값은 로컬에 저장하고 `turn/start.effort`로 전달합니다. 자동 선택은 모델 기본값을 사용하며 Fast를 켜면 지원되는 경우 Low를 적용합니다. 직접 선택한 강도는 Fast보다 우선합니다. 계정 자동 전환도 선택한 강도를 지원하는 계정에만 허용하며, 모델이나 계정을 바꾼 뒤 해당 강도가 지원되지 않으면 다시 선택하도록 안내합니다.

Codex Fast 토글은 모델 목록에서 Fast 서비스 티어를 제공한다고 알리는 경우에만 그 티어를 요청합니다. 티어 정보가 없는 모델은 자동 또는 Low 선택에서만 Fast를 사용할 수 있습니다. 이 앱은 서버가 실제로 처리한 속도 티어의 별도 확인 신호를 제공하지 않습니다. Claude에서는 추론 강도 선택과 Fast 토글을 사용하지 않습니다. 프로젝트를 삭제해도 해당 대화는 보존되고 ‘모든 대화’로 이동합니다. Codex 연결 해제는 app-server의 `account/logout`을 사용하며, 기본 계정은 `~/.codex`를 공유하므로 Codex CLI에서도 로그아웃됩니다. 추가 계정을 삭제하면 해당 `CODEX_HOME`의 인증 정보와 Codex 세션 기록이 제거됩니다. Mosaic 대화 본문은 남고 다음 응답은 다른 계정에 대화 내용으로 이어집니다. Claude 연결 해제는 Claude Code CLI의 `auth logout`을 실행합니다. 진행 중인 Codex 응답은 계정 삭제나 연결 해제를 막습니다.
