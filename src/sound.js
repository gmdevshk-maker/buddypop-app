// ============================================================
// 🔊 오디오 파일 기반 효과음 + 배경음악
// 음원: public/snd/  (효과음 = Google Sound Library, CC-BY 4.0
//                     BGM "Pixelland" = Kevin MacLeod, CC-BY 3.0)
// ============================================================

const SFX_SRC = {
  click:    "/snd/click.ogg",
  pop:      "/snd/pop.ogg",
  invalid:  "/snd/invalid.ogg",
  combo:    "/snd/combo.ogg",
  levelup:  "/snd/levelup.ogg",
  win:      "/snd/win.ogg",
  gameover: "/snd/gameover.ogg",
};

let muted = false;

// 효과음 미리 로드
const clips = {};
for (const [key, src] of Object.entries(SFX_SRC)) {
  const a = new Audio(src);
  a.preload = "auto";
  clips[key] = a;
}

// 같은 효과음이 빠르게 겹쳐도 끊기지 않도록 복제 노드로 재생
function play(key, volume = 1) {
  if (muted) return null;
  const base = clips[key];
  if (!base) return null;
  const node = base.cloneNode();
  node.volume = Math.max(0, Math.min(1, volume));
  node.play().catch(() => {});
  return node;
}

// 레벨업/승리/게임오버처럼 긴 징글은 한 번에 하나만 — 상태가 바뀌면 끊는다
let jingle = null;
function playJingle(key, volume) {
  stopJingle();
  jingle = play(key, volume);
}

export function stopJingle() {
  if (jingle) {
    jingle.pause();
    jingle.currentTime = 0;
    jingle = null;
  }
}

export const sfx = {
  click:    () => play("click", 0.5),
  pop:      (_count, volume = 0.7) => play("pop", volume),
  invalid:  () => play("invalid", 0.6),
  combo:    () => play("combo", 0.8),
  levelup:  () => playJingle("levelup", 0.9),
  win:      () => playJingle("win", 0.8),
  gameover: () => playJingle("gameover", 0.7),
};

// ── 배경음악 (화면별 루프) ────────────────────────────────
const BGM_SRC = {
  lobby: "/snd/lobby.mp3", // 첫 화면: "Carefree" (밝은 우쿨렐레)
  game:  "/snd/bgm.mp3",   // 게임: "Pixelland" (경쾌한 8비트)
};
const BGM_VOL = { lobby: 0.3, game: 0.25 };

let bgm = null;
let bgmKey = null;

function playBgm(key) {
  // 이미 같은 곡이 재생 중이면 그대로 둔다
  if (bgmKey === key && bgm) {
    if (!muted) bgm.play().catch(() => {});
    return;
  }
  if (bgm) bgm.pause(); // 다른 화면 곡은 멈추고 교체
  bgmKey = key;
  bgm = new Audio(BGM_SRC[key]);
  bgm.loop = true;
  bgm.volume = BGM_VOL[key];
  if (!muted) bgm.play().catch(() => {});
}

export const startLobbyBgm = () => playBgm("lobby");
export const startBgm = () => playBgm("game"); // 게임 진입 시 (기존 호출 호환)

export function stopBgm() {
  if (bgm) bgm.pause();
}

// 파일 방식은 별도 오디오 컨텍스트가 필요 없다 (API 호환용 no-op)
export function ensureAudio() {}

// ── 음소거 ────────────────────────────────────────────────
export function toggleMute() {
  muted = !muted;
  if (bgm) {
    if (muted) bgm.pause();
    else bgm.play().catch(() => {});
  }
  return muted;
}

export function isMuted() {
  return muted;
}
