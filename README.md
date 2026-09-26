# Mosaic AI

OpenAI와 Anthropic 공식 API를 한 화면에서 선택해 사용하는 로컬 웹 채팅 MVP입니다. 대화는 현재 브라우저의 `localStorage`에 저장되고, API 키는 서버 환경 변수에서만 읽습니다.

## 실행

1. Node.js 20 이상을 준비합니다.
2. 이 폴더에서 `.env.example`을 `.env`로 복사합니다.
3. 사용할 API 키를 `.env`에 입력합니다.

```dotenv
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

4. 서버를 실행합니다.

```bash
npm start
```

5. 브라우저에서 [http://127.0.0.1:4173](http://127.0.0.1:4173)을 엽니다.

의존성 설치가 필요 없습니다. 서버는 기본적으로 `127.0.0.1`에서만 대기합니다. 외부 네트워크에 공개하려면 별도의 인증·배포 보안 설계가 필요합니다.

## 포함된 기능

- OpenAI와 Claude 제공자·모델 선택
- 응답 스트리밍, 대화 생성·전환·삭제
- 브라우저 내 대화 기록 저장
- 연결 상태 표시와 API 오류 안내
- 서버 환경 변수로 API 키 비공개 관리

구독 계정 OAuth, Codex/Claude Code 로컬 에이전트 실행, 계정 간 자동 전환, 파일 업로드, 웹 검색 도구는 포함하지 않았습니다. OpenAI와 Anthropic API 사용량은 각 계정의 API 요금 및 사용 한도를 따릅니다.
