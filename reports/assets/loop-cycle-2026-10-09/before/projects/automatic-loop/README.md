# Focus Board

학습 작업을 추가하고, 진행 상태를 관리하며, 과목이나 제목으로 검색할 수 있는 한국어 학습 작업 관리 앱입니다. 작업은 브라우저의 `localStorage`에 저장됩니다.

## 실행

Node.js 20 이상이 설치되어 있어야 합니다. 프로젝트 루트에서 다음 명령을 실행하세요.

```sh
node server.mjs
```

앱은 기본 주소 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)에서 열립니다. 포트를 바꾸려면 `PORT` 환경 변수를 지정하세요.

```sh
PORT=3001 node server.mjs
```

## 테스트

전체 모델, UI 및 서버 테스트를 실행하려면 프로젝트 루트에서 다음 명령을 사용하세요.

```sh
node --test
```

## Chromium 브라우저 저장 복구 점검

README의 실행 방법으로 앱을 시작한 뒤 Chromium에서 `http://127.0.0.1:3000/`을 열고, 개발자 도구 Console에서 다음 두 저장 손상 사례를 각각 확인하세요.

1. 잘못된 JSON을 저장하고 새로고침합니다.

   ```js
   localStorage.setItem('focus-board-v1', '{broken json');
   location.reload();
   ```

2. JSON은 파싱되지만 작업 값이 유효하지 않은 데이터를 저장하고 새로고침합니다.

   ```js
   localStorage.setItem('focus-board-v1', JSON.stringify([
     { id: 'bad', title: '', subject: '수학', minutes: 20, completed: false },
   ]));
   location.reload();
   ```

각 새로고침 후 `#statusMessage`에 빈 목록 안내가 보이고, `.task`가 0개이며, `#emptyState`가 보이고, `#totalCount`가 `0`인지 확인합니다. 이어서 화면에서 정상 작업을 추가하고 새로고침하여 작업이 한 개 복원되는지 확인합니다. 두 사례의 실제 Chromium 실행 결과를 각각 기록하세요.
