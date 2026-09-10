# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- UI는 VS Code 확장의 Webview(HTML/CSS/JS, CSP 제한, nonce 필요). 데스크톱 확장이며 iOS/Android 네이티브가 아님 - 그 OS의 기기를 "관리"만 한다. -->

## Users

Windows에서 일하는 모바일 앱 보안 연구자 / 리버스 엔지니어 / 펜테스터. 루팅된 Android 폰과
탈옥된 iOS 기기를 여러 대 다루고, 기기마다 다른 Frida 버전을 써야 한다. 1차 배포 대상은
작성자 본인과 같은 팀/동료(사내 `.vsix` 공유).

## Product Purpose

기기마다 다른 Frida 버전 조합을 다룰 때 생기는 반복 작업을 없앤다:
- Frida/frida-tools 버전별로 분리된 Python 가상환경(venv)을 "프로필"로 관리
- 클릭 한 번으로 그 venv가 activate된 통합 터미널을 연다
- 그 프로필의 Frida 버전에 맞는 frida-server를 기기(Android=adb, iOS=SSH)에 자동 설치·실행
"완성" = 팀에 `.vsix`로 배포할 수 있는 상태 (번들러 도입 + 첫 실행이 헷갈리지 않을 것).

## Positioning

- venv activate를 **터미널 생성 시점**에 `cmd /K activate.bat`로 직접 건다. 워크스페이스 설정/
  상태에 안 기대므로 항상 확실하게 해당 venv가 켜진 터미널이 뜬다.
- 새 프로필 만들 때 PyPI 메타데이터(`requires_dist`)를 읽어 그 Frida 버전과 실제로 호환되는
  frida-tools 버전만 보여준다 (pip 의존성 충돌 조합을 애초에 차단).
- 프로필의 물리 폴더명은 생성 후 불변 (Windows venv의 pip 콘솔 스크립트가 절대경로를 내장하므로
  rename하면 깨짐). 사용자에게 보이는 라벨(display_name)만 따로 관리.

## Operating Context

- Windows 10/11, VS Code Extension Development Host(F5)로 실행/개발.
- 외부 CLI: `adb`(Android), `py` 런처(프로필). iOS SSH는 `ssh2` 라이브러리로 직접 붙어 외부 도구가 없다.
- 네트워크: GitHub Releases(frida-server .xz/.deb 다운로드), PyPI(버전 조회).
- 저장 위치: `context.globalStorageUri` (profiles.json / devices.json / ios-devices.json / venvs/ / scripts/).
- 기기: 루팅 Android(su로 데몬 실행), 탈옥 iOS(SSH root 세션).

## Capabilities and Constraints

**기능**
- 프로필: 생성(버전 선택 + 실시간 설치 로그 + 취소/정리) / 표시이름 변경 / 터미널 열기 / venv 삭제.
- 사이드바 트리 3개: 프로필 / Android 기기 / iOS 기기. 트리 항목 인라인 = 셸 접속 버튼만.
- 통합 관리창(뷰당 톱니 아이콘 1개 + 새로고침): 탭으로 생성/등록·관리·frida-server. 도구 경로(py/adb)는 VS Code 설정에 직접 있어 관리창에 설정 탭이 없다(3패널 모두 2탭).
- Android: adb 기기 감지 → 등록 → 별명 → frida-server(GitHub .xz → adb push → su 데몬) 설치/실행/종료/상태확인 → "파일 추출"(adb root 안 되는 기기는 su로 /sdcard 경유 후 pull).
- iOS: **SSH 정보 수동 입력으로만** 등록(호스트/포트/유저/키 or 비밀번호) → frida-server(.deb 순수 JS 추출 → SFTP 전송 → 실행). SSH 접속은 `ssh2` 라이브러리로 처리, 키·비밀번호 둘 다 자동화된다. "SSH 터미널"도 저장된 인증 정보가 있으면 `ssh2` shell 채널(Pseudoterminal)로 자동 로그인하고, 없을 때만 Windows 기본 `ssh`로 폴백한다.
- `.js` 우클릭 → "이 스크립트로 실행": 프로필 → spawn(-f)/attach(-n) → 대상 → 기기 선택(adb 기기 + 등록된 iOS 기기, 1대면 자동, 여러 대면 QuickPick, 0대면 `-U`) → 재사용 터미널에 `frida -D <시리얼>` / `-H <host>` / `-U` 명령 입력. 고른 기기의 frida-server 버전이 프로필과 다르거나 안 떠 있으면 먼저 modal 경고 (`frivenv.checkConnection`도 동일).
- 각 동작 버튼(상태 확인/실행/종료 등)을 우클릭하면 실제 adb/ssh 명령어를 클립보드로 복사(보고서용). `⧉` 버튼으로도 노출됨.

**제약**
- Windows 전용. venv 폴더명 불변. Webview는 CSP 제한(외부 리소스 불가, nonce 필수), light/dark 테마 모두에서 `--vscode-*` 변수로 렌더링돼야 함.
- 자동화 테스트 없음. `.vsix`는 `npm run package`(esbuild 번들 + `vsce package`)로 생성.

**용어**: `profile`(=버전 고정 venv), `name`(불변 폴더명), `display_name`(표시 라벨),
`frida-server`(기기에서 도는 데몬), `dataDir`(globalStorage 경로).

## 목표 / 다음 단계

"완성"(팀에 `.vsix` 배포 가능 + 첫 실행이 안 헷갈림) 까지 남은 것을 3덩이로 본다.

- **M1 — 배포 가능** ✅: `esbuild.js`가 `src/extension.ts`+의존성(ssh2 포함)을 `dist/extension.js`
  하나로 번들, `npm run package` → `vsce package`로 `.vsix`(~140 KB, node_modules 없음).
  네이티브 애드온(`cpu-features`/`*.node`)만 external → ssh2가 순수 JS로 폴백.
- **M2 — 첫 실행이 안 막힘** ✅: `py`/`adb` 미탐지 시 그 뷰의 `viewsWelcome`이 설치·경로 지정·
  다시 확인 링크를 띄운다 (`envCheck.ts` → `frivenv:pyMissing`/`frivenv:adbMissing`).
- **M3 — 버전 루프 닫기** ✅:
  1. `.js 실행` 때 고른 기기의 frida-server 버전 ≠ 프로필 frida 버전이거나 안 떠 있으면 경고.
  2. `.js 실행`이 adb 기기 1대면 `-D <시리얼>`, 2대 이상이면 고르게 함(더 이상 `-U`로 ambiguous 안 남).
  3. `Frida: 기기 연결 확인` 명령: `frida-ps -D/-U`를 프로필 터미널에 넣어 실제 attach 확인.

범위 밖(하면 좋지만 목표 아님): 자동화 테스트(순수 JS 조각 스모크), iOS 기기 모델/버전 표시(`sw_vers`).

## Brand Commitments

- 이름: **Frivenv**. 아이콘: `media/icon.svg`.
- UI 텍스트는 한국어(작성자 CLAUDE.md 지시). 영어 다국어 대응은 범위 밖.

## Evidence on Hand

- `README.md` — 상세한 기능 설명서 (일부는 앞서나간 기술: `verify.ts`/"설치 확인"은 미구현이며 만들지 않음).
- 실제 동작 코드 전체(`src/`). 스크린샷/골든/데모 없음 — 만들어내지 말 것.
- `.vsix` 배포본 없음(아직).

## Product Principles

1. **확실함이 편의보다 우선** — venv activate는 터미널 생성 시점에 직접 건다. 상태 추론 안 함.
2. **깨질 조합을 애초에 막는다** — 호환 안 되는 frida-tools 버전은 목록에 안 띄운다. 불변 폴더명.
3. **진짜 진행률만 보여준다** — 다운로드/설치 퍼센트는 실제 바이트/단계 기준. 가짜 애니메이션 없음.
4. **창은 하나** — 뷰당 톱니 하나가 통합 관리창을 열고, 그 안 탭에서 모든 기능. 트리 인라인은 셸 접속만.
5. **외부 도구는 선택** — CLI 경로 비워두면 자동 탐지. 자동 탐지가 안 될 때만 사용자가 지정.

## Accessibility & Inclusion

VS Code 테마 토큰(`--vscode-*`)을 써서 light/dark 모두에서 정상 대비 확보. 키보드로 폼 완주 가능해야 함.
스크린리더 완전 대응은 1차 범위 밖(사내 배포).
