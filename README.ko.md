# Frivenv — Windows용 VS Code 확장

**Frida 버전마다 Python venv를 하나씩 두고, 그 버전에 맞는 `frida-server`를 루팅한
안드로이드·탈옥한 iOS 기기에 올립니다. 버전을 바꿔도 venv를 다시 만들 필요가 없습니다.**

**[English](README.md) · 한국어**

## 설치

마켓플레이스에는 없어서 `.vsix`를 직접 설치합니다 — 두 단계입니다.

### 1. `frivenv.vsix` 다운로드

[최신 릴리스](https://github.com/xorren/frivenv/releases/latest) 페이지에서
`frivenv.vsix` 자산을 클릭하거나, 터미널에서 한 줄:

명령 프롬프트 (cmd):
```
curl -LO https://github.com/xorren/frivenv/releases/download/v0.0.1/frivenv.vsix
```
PowerShell:
```
curl.exe -LO https://github.com/xorren/frivenv/releases/download/v0.0.1/frivenv.vsix
```

### 2. 설치

파일을 받은 폴더에서:

```
code --install-extension frivenv.vsix
```

터미널 없이: VS Code → 확장(`Ctrl+Shift+X`) → `···` → **VSIX에서 설치** →
`frivenv.vsix` 선택.

## 기능

![Frivenv 작업 흐름](media/features.png)

- **프로필** — `frida` / `frida-tools` / Python 조합마다 venv 하나; 호환되는 `frida-tools`만 제시합니다.
- **frida-server** — 등록한 기기마다 다운로드·전송·실행·종료·삭제.
- **스크립트 실행** — `.js` 우클릭 → 프로필·기기 선택; 버전이 다르면 경고합니다.
- **기기** — Android는 `adb`, 탈옥 iOS는 SSH; 별명·실시간 상태·파일 추출·APK 설치.

## 준비물

| 필요 | 용도 |
| --- | --- |
| **Windows** · **VS Code 1.85 이상** | 확장 자체 |
| **`py`** 런처 | 프로필(가상환경) 생성 |
| **`adb`** | 안드로이드 기기 — *iOS는 준비물 없음, SSH 내장* |

`py` / `adb`가 없으면 사이드바에서 설치 링크와 함께 알려줍니다.

## 설정

VS Code 설정 화면에 나오는 순서 그대로입니다.

| 설정 | 기본값 | |
| --- | --- | --- |
| `frivenv.language` | `auto` | `auto`는 VS Code 언어를 따름, `ko` / `en`으로 고정 |
| `frivenv.showInExplorer` | `true` | 탐색기에 **Frivenv** 섹션 하나로 트리 표시 (끄면 활동표시줄 뷰만 사용) |
| `frivenv.pythonLauncherPath` | PATH | `py` 경로 (첫 실행 시 자동 감지) |
| `frivenv.adbPath` | PATH | `adb` 경로 (첫 실행 시 자동 감지) |
| `frivenv.dataDir` | 확장 저장소 | 프로필 + 가상환경 |
| `frivenv.scriptsDir` | 열린 작업 폴더 | 프로필 터미널이 열리는 폴더 — `frida -l hook.js`를 짧게 |
| `frivenv.iosFridaServerDir` | 자동 | iOS 기기에서 frida-server를 설치할 폴더. 비워두면 자동 감지 (루트리스 `/var/jb/usr/sbin` vs 루트풀 `/usr/sbin`) |

## 빌드

```powershell
npm install
npm run package   # -> frivenv.vsix
```

개발은 `npm run compile` / `watch` / `check`, 디버그는 F5.

## 참고

iOS SSH 비밀번호는 `ios-devices.json`에 평문 저장됩니다. UI는 영어/한국어, 코드와
주석은 영어. MIT.
