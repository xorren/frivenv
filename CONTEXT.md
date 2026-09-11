# Frivenv 용어집

용어 뜻만 적는다. 구현·아키텍처는 README와 코드 주석에. 제품 사실은 `PRODUCT.md`.
새 용어가 정해지면 여기 바로 추가한다.

## 프로필

- **프로필**: Python·frida·frida-tools 버전이 고정된 가상환경 하나. `profiles.json`의 한 항목.
  새 프로필 탭의 3개 모드: **생성**(새 venv) / **등록**(미등록 venv를 목록에 넣기, 필요하면 pip 설치) /
  **수정**(등록된 프로필의 frida 버전 교체 — 그 venv에 재설치). 등록·수정은 host의 `setupExistingVenv`
  하나로 처리(경로가 이미 프로필이면 그 항목 갱신, 아니면 새로 추가). 실패해도 그 venv는 안 지운다.
- **폴더 이름** (`name`): 유일 키. 새로 만들 땐 랜덤 슬러그(`frivenv-a1b2c3d4`, 사용자가 바꿀 수 있음),
  가져올 땐 그 폴더 basename. 만든 뒤엔 못 바꾼다(venv의 pip 스크립트가 절대경로를 담고 있어서).
- **표시 이름** (`display_name`): 사용자가 붙이는 라벨. UI에는 이걸 보여준다. 안 바꾸면 폴더 이름을 따라간다.
- **가상환경**: `venv_dir`이 그 절대경로. 보통 `venvs/<name>` 이지만 가져온 venv는 임의 경로일 수 있다.
- **스크립트 폴더**: 프로필 터미널이 시작되는 폴더 — `frida -l hook.js`를 짧은 상대경로로 쓰기 위한 것.
  `frivenv.scriptsDir` 설정 → 열린 작업 폴더 → `dataDir/scripts` 순으로 결정된다. `runScript`는 스크립트가
  이 폴더 아래면 상대경로로, 아니면 절대경로로 `-l`에 넣는다.

## 기기 · frida-server

- **기기**: 진단 대상 단말. Android(adb)와 iOS(SSH)는 등록부·트리뷰가 따로다.
- **등록**: 기기를 등록부(`devices.json` / `ios-devices.json`)에 넣는 것. 등록해야 별명·frida-server를 관리한다.
  Android는 adb로 잡힌 기기를 "등록" 버튼으로, iOS는 SSH 접속 정보를 입력해 추가한다.
- **frida-server**: 기기에서 도는 데몬. 프로필의 frida 버전과 맞아야 `frida`가 붙는다.
  `.js 실행`/`연결 확인`은 adb 기기가 1대면 `-D <시리얼>`, 여러 대면 고르게 하고, 버전이 다르면 경고한다.
  GitHub 릴리스에서 받아(Android `.xz`, iOS `.deb`) 기기에 올리고 실행한다.
- **frida-server 폴더**: frida-server 바이너리를 모아두는 기기 안 폴더. 버전마다 `frida-server-<버전>`으로
  따로 저장한다. 기기마다 경로를 지정한다. iOS는 비우면 자동 감지(루트리스 `/var/jb/usr/sbin` vs
  루트풀 `/usr/sbin`), `frivenv.iosFridaServerDir` 설정으로 기본값도 지정 가능. 같은 경로에 다른 버전
  바이너리가 이미 있으면 덮어쓰기 전에 확인. 입력칸 옆 "기본값" 버튼은 빈 값을 저장해 기본 경로를 다시
  쓰게 한다(잘못 바꿨을 때 복구용).
- **iOS 업로드(설치)**: root SSH면 SFTP로 바로 폴더에 올리고 `chmod 755`. **root가 아니면**(예: `mobile`)
  시스템 폴더(`/var/jb/usr/sbin`)가 root 소유라 SFTP가 "Permission denied" — 그래서 홈(`$HOME`)에 먼저
  올린 뒤 `sudo -S`(비밀번호 stdin)로 `mv` + `chmod`. sudo·비밀번호가 없으면 그냥 시도만 하고 실패할 수
  있다(`ssh.ts` `pushFridaServerBinary`).
- **실행 중인 파일로 맞추기**: frida-server가 저장/선택된 파일이 아닌 다른 파일에서 돌고 있으면 상태줄에
  `실행 중 · <버전> · <경로>`가 뜨고, 그 옆 버튼 한 번으로 폴더·저장 버전·삭제 대상을 실제 실행 파일에
  맞춘다(`alignToRunning`).
- **실행 명령 편집** (iOS): 탈옥 방식(루트풀·루트리스·커스텀)마다 frida-server 실행 셸이 달라서, iOS Frida
  Server 카드의 "실행 명령 직접 편집" 블록에서 launch 명령을 기기마다 고칠 수 있다. 치환자
  `{path}`/`{dir}`/`{pw}`(SSH 비밀번호, 로그엔 그대로 노출 안 됨). 기본값과 같으면 `ios-devices.json`에
  저장 안 함(`runCmd`, 빈 값 = 기본값). 업로드·권한은 편집 대상 아님. Android은 없다(adb push/run이 표준).
- **APK 설치** (Android): 등록된 기기 카드의 "APK 설치" 버튼 → 로컬 `.apk` 선택 → 런타임 권한 처리 방식
  선택(일반 / `-g` 모두 허용) → `adb -s <시리얼> install -r [-g]`. iOS는 별도 툴(ideviceinstaller 등)이
  필요해 넣지 않았다.
- **APK 추출** (Android): "APK 추출" 버튼 → `pm list packages -3`로 사용자 앱 목록 QuickPick → `pm path`로
  경로(스플릿이면 여러 개) → 각각 `adb pull`을 `<저장폴더>/<패키지명>/`으로. `/data/app` APK는 world-readable
  라 root 불필요. iOS `.ipa`는 암호화 바이너리라 스킵.
- **자동화** (iOS): 상태 확인·업로드·실행·종료를 코드로 하는 것. 호스트와 인증 정보(개인 키 또는
  비밀번호)가 저장돼 있으면 된다. SSH 접속은 `ssh2` 라이브러리로 직접 붙는다.
- **인증 방식** (iOS): `key`(개인 키 파일) 또는 `password`(비밀번호, `ios-devices.json`에 평문 저장). 둘 다 자동화된다.

## 외부 도구 · 저장소

- **도구 경로**: `adb` / `py` 실행 파일의 지정 경로. `frivenv.adbPath` · `frivenv.pythonLauncherPath` 설정
  (예전 `frivenv.tools.*` 네임스페이스는 뺐다 — 설정 화면이 한 줄로 정렬되도록. 활성화 때 옛 값 자동 이전).
  각 설정엔 `order`를 달아 화면 순서를 고정: language → showInExplorer → pythonLauncherPath → adbPath →
  dataDir → scriptsDir → iosFridaServerDir (README 표와 동일). 비우면 PATH에서 찾는다.
  iOS SSH는 외부 도구가 필요 없다(`ssh2` 번들). "SSH 터미널"도 저장된 키·비밀번호가 있으면 `ssh2`
  shell 채널을 `Pseudoterminal`로 띄워 자동 로그인하고(`sshTerminal.ts`), 인증 정보가 없을 때만
  Windows 기본 `ssh`로 폴백(그땐 사용자가 비밀번호 입력). `connectClient`는 소켓을 직접 만들어
  `setNoDelay(true)`로 Nagle을 꺼서 타이핑 지연을 줄인다. 그래도 ssh2 pty는 키마다 원격 echo 왕복이라
  타이핑이 끊길 수 있다(Android `adb shell`은 `shellPath` 터미널이라 VS Code predictive echo가 먹혀서
  안 끊김). iOS 기기별 **"터미널 자동 로그인" 체크박스**(`terminalManualAuth`, SSH 폼)를 끄면 OS `ssh`로
  터미널을 열어(비밀번호 매번 입력) predictive echo를 얻는다. 자동화(상태 확인·업로드·실행)는 이 설정과
  무관하게 항상 ssh2 + 저장 자격증명.
- **환경 점검**: 활성화 때 `envCheck.ts`가 `py`/`adb`를 확인해 context 키 `frivenv:pyMissing` /
  `frivenv:adbMissing`를 세운다. 없으면 그 뷰의 `viewsWelcome`이 설치·경로 지정·다시 확인 링크를 띄운다.
  `frivenv.recheckEnv` 명령이나 `frivenv.adbPath` · `frivenv.pythonLauncherPath` 설정 변경 때 다시 확인한다.
- **다국어**: 런타임 UI 문자열은 `src/i18n.ts`의 `t("key", ...args)` (`{0}` 치환). 사전은
  `src/i18n/ko.ts` / `en.ts`, 같은 key로 양쪽에 추가. 언어는 `frivenv.language` 설정
  (`auto`=VS Code UI 언어 따름 / `ko` / `en`). package.json 안 문자열(명령 제목·설정 설명·
  viewsWelcome)은 활성화 전 로드되므로 `%key%` + `package.nls.json`(영어 기본)/`package.nls.ko.json`,
  이쪽은 VS Code 표시 언어를 따름. 설정이 바뀌면 트리 새로고침 + 열린 관리 창 다시 렌더.
  웹뷰엔 `bundleFor("prefix")`로 문자열 묶음을 `<script>`에 주입.
- **dataDir**: `profiles.json` / `devices.json` / `ios-devices.json` / `venvs/` / `scripts/`가 있는 폴더.
  기본은 VS Code가 확장에 할당한 저장소.

## 창 · 뷰

- **관리 창**: 뷰마다 하나. 사이드바 톱니 아이콘이 연다. 창 안은 탭으로 나뉜다.
  설정 탭은 없다 — 도구 경로(`py`/`adb`)는 VS Code 설정(`frivenv.adbPath` · `frivenv.pythonLauncherPath`)에 직접 있다.
  `frivenv.configureProfileTools` / `configureDeviceTools` 명령은 설정 UI를 그 항목으로 연다.
- **인라인 아이콘**: 트리 항목 오른쪽 아이콘. venv 터미널 열기는 `$(terminal)` — 프로필 항목,
  그리고 기기 항목의 "호환 프로필 터미널"(둘 다 내 PC의 venv 셸이라 같은 아이콘). 기기 안으로
  접속하는 adb 셸 / iOS SSH 셸은 `$(vm-connect)`로 구분.
- **순서 바꾸기**: 프로필·등록 기기 카드 헤드의 `▲▼` 버튼(`pkMoveBtns`, msgType 인자로 프로필/기기
  구분) → `moveProfile`/`moveDevice`/`moveIosDevice` 메시지 → 스토어에서 배열 자리 교환 →
  `sendProfiles()`/`sendDevices()`로 창(두 탭 모두) 재렌더 + `onChanged`로 트리 동기화. 트리 항목
  우클릭 "위로/아래로 이동"(`frivenv.moveItemUp`/`moveItemDown`)도 같은 스토어 함수를 쓰고, 열려 있는
  창에는 `ManageXPanel.refreshIfOpen()`으로 밀어 넣는다(양방향 실시간). **연결됨 우선 정렬은 없앴다** —
  Android 트리·패널 모두 등록 기기는 `devices.json` 순서 그대로, 미등록·연결된 기기만 맨 뒤.
- **호환 프로필**: 기기의 frida-server 버전과 같은 frida 버전을 쓰는 프로필. `$(terminal)` 아이콘이 그
  venv 터미널을 연다(`frivenv.openProfileTerminalForDevice`). 버전이 같은 프로필이 여럿일 수 있어서
  (설치한 pip 모듈이 다르거나) 기기마다 `preferredProfile`(프로필 `name`)로 고정 가능 — 고정은
  **Frida 관리 탭 카드 최상단의 "호환 프로필" 드롭다운**에서(`devices.json`/`ios-devices.json`에 저장,
  "자동" = 해제). 고정이 있으면 그걸 열고, 없으면 버전 일치 프로필로: 1개면 바로, 여러 개면 고르게.
  `resolveCompanionProfile`(profileStore.ts)이 로직, 트리 provider가 이걸로 `contextValue`에 `Linked`
  접미사를 붙여 아이콘 표시 여부를 정한다. 현재 연결된 프로필은 pill로 두 탭(기기 목록 + Frida 관리)
  모두에 표시되며(`pkServerMatchPill`), 고정이 있으면 자동 매칭보다 고정을 보여준다.
- **2단계 렌더 + 카드 단위 갱신**: `sendDevices()`는 `shallowRow()`(등록부만)로 `devices`를 한 번
  보내고(연결 상태 `probing`), `probeRow()`로 adb/SSH 조회 후 `devices`를 다시 보낸다. **한 기기에만
  영향 주는 동작**(run/stop/install/check/delete/폴더 변경/align/별명/SSH 정보 저장)은 `sendDevices()`
  대신 `refreshOneDevice(id)` → 그 기기만 다시 조회해 `deviceRow` 메시지 하나를 보낸다. 웹뷰의
  `pkRenderServerCards`는 **keyed reconcile**(`data-id` + 행 JSON 비교) — 데이터가 바뀐 카드만 다시
  그린다. 전체 새로고침은 `ready`/`refresh`/`registerDevice`/`moveDevice`/`remove`만.
- **조회 타임아웃**: 등록 기기가 0대일 때만 "조회 중… (N초)" 카운터가 뜨고, 60초를 넘기면 멈추고
  네트워크·프록시 확인 후 새로고침하라는 안내로 바뀐다(`wc.loadingTimeout`, panelKit `pkLoadingTick`).
- **탐색기 미러링**: `frivenv.showInExplorer`가 켜지면 파일 탐색기 하단에 `frivenvExplorer` 뷰 하나가
  뜬다. `FrivenvExplorerTreeProvider`가 프로필/Android/iOS 카테고리 행 3개를 만들고, 펼치면 각 행의
  자식은 기존 세 provider에 그대로 위임한다(자체 로직 없음, 세 provider의 refresh를 따라감).
  토글은 `Ctrl+,` 설정 또는 명령 팔레트(`Frida: 탐색기에 뷰 표시` / `숨기기`) — 뷰 인라인 메뉴엔 없다.
