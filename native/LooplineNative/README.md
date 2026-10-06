# Loopline Native for macOS

Loopline의 네이티브 macOS 클라이언트입니다. WebView 없이 React Native for macOS 화면을 사용하고, 기존 Loopline API 서버를 통해 연결된 모델에 요청합니다.

## 제공 기능

- Codex, Claude Code, API 연결 모델 목록 조회 및 선택
- 실시간 채팅 응답과 대화 기록 저장
- Loop Engineering 회차 설정, 진행 상태 확인, 중지
- 단계별 사용 모델과 모델에 전달한 주요 문맥 확인
- 로컬 서버 연결 상태와 주소 설정

## 실행

저장소 루트에서 먼저 기존 서버를 실행합니다.

```sh
npm start
```

다른 터미널에서 macOS 앱을 실행합니다.

```sh
npm run native:macos
```

최초 설정 또는 네이티브 의존성 변경 후에는 앱 의존성과 잠긴 Ruby/CocoaPods 의존성을 준비합니다.

```sh
cd native/LooplineNative
npm install
bundle install
bundle exec pod install --project-directory=macos
```

앱을 빌드하려면 저장소 루트에서 다음을 실행합니다.

```sh
npm run native:build
```

## 연결과 저장

기본 서버 주소는 `http://localhost:4173`입니다. 현재 서버는 로컬 주소에서만 요청을 받으며, 앱도 localhost 외의 주소를 차단합니다. LAN이나 인터넷을 통한 원격 사용은 지원하지 않습니다.

이 앱의 대화 기록과 선택 설정은 React Native macOS의 로컬 저장소에 따로 보관합니다. 기존 웹앱의 대화를 자동 가져오지는 않습니다. Codex·Claude Code·API 연결은 데스크톱 앱의 기존 설정을 사용하므로, 해당 데스크톱 서버와 계정 연결이 실행 중이어야 합니다.

## 현재 범위

이번 앱은 채팅과 Loop 경험을 위한 첫 네이티브 클라이언트입니다. Harness 프로젝트 폴더 관리, 독립 브라우저 QA, MCP 서버·Plugin 관리, ChatGPT·Gemini 웹 대화, 데스크톱 계정 연결·인증 화면은 기존 데스크톱 앱에서 계속 사용해야 합니다.
