# Focus Board

Focus Board는 브라우저의 `localStorage`에 학습 작업을 저장하는 반응형 작업 보드입니다. 외부 라이브러리나 네트워크 호출을 사용하지 않습니다.

## 실행

Node.js 20 이상에서 프로젝트 루트에서 다음 명령을 실행하세요.

```sh
node server.mjs
```

기본 주소는 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)입니다. 다른 포트를 사용하려면 `PORT` 환경 변수를 지정하세요.

```sh
PORT=4000 node server.mjs
```

## 테스트

```sh
node --test
```

서버 테스트는 요청 처리 함수를 가짜 request/response로 호출하므로 소켓을 열지 않습니다.
