# Loopline Native

Loopline의 React Native 클라이언트입니다. macOS에서는 기존 데스크톱 화면을 유지하고, iOS에서는 Tailscale을 통해 Mac Loopline에 연결하는 전용 휴대폰 화면을 제공합니다.

## 제공 기능

- Codex, Claude Code, API 연결 모델 목록 조회 및 선택
- 실시간 채팅 응답과 대화 기록 저장
- Loop Engineering 회차 설정, 진행 상태 확인, 중지
- 단계별 사용 모델과 모델에 전달한 주요 문맥 확인
- 로컬 서버 연결 상태와 주소 설정
- iPhone에서 Loopline Mac으로 안전하게 연결
- 원격 대화와 계획·구현·판정 역할별 모델 선택
- Loop 단계 상태 확인, 중지 및 이어하기

## 실행

저장소 루트에서 먼저 기존 서버를 실행합니다.

```sh
npm start
```

다른 터미널에서 macOS 앱을 실행합니다.

```sh
npm run native:macos
```

iOS Simulator 또는 연결된 iPhone에서는 다음 명령을 실행합니다. 최초 설정 시에는 CocoaPods 의존성을 설치합니다.

```sh
cd native/LooplineNative
bundle install
bundle exec pod install --project-directory=ios
cd ../..
npm run native:ios
```

iOS Simulator용 Release 빌드는 다음 명령으로 생성할 수 있습니다.

```sh
npm run native:build:ios
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

macOS 앱은 기본적으로 `http://localhost:4173`에 연결합니다. iOS 앱은 `https://<Mac의-Tailscale-DNS>/loopline` 주소를 사용합니다. iPhone에 Tailscale을 설치하고 Mac과 같은 Tailnet에 연결한 뒤, Mac Loopline의 원격 제어 화면에서 Tailscale Serve를 켜야 합니다. 원격 게이트웨이는 Tailnet 로그인 신원을 확인하고, 임의 로컬 폴더나 MCP 도구를 원격 작업에 노출하지 않습니다.

대화 기록, 서버 주소, 모델 선택과 현재 Loop 실행 ID는 각 기기의 로컬 저장소에 보관합니다. 기존 웹앱의 대화를 자동 가져오지는 않습니다. Codex·Claude Code·API 연결은 Mac Loopline의 기존 설정을 사용하므로, Mac 앱과 계정 연결이 실행 중이어야 합니다.

## 현재 범위

이번 iOS 화면은 원격 대화와 Harness Loop 제어에 집중합니다. Harness 프로젝트 폴더 관리, 독립 브라우저 QA, MCP 서버·Plugin 관리, ChatGPT·Gemini 웹 대화, 계정 연결·인증 화면은 macOS 앱에서 계속 사용해야 합니다. 실제 iPhone 사용에는 iOS Tailscale 앱의 설치와 Tailnet 로그인이 필요합니다.
