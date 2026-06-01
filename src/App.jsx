import { useState, useEffect, useCallback, useRef, memo } from "react";
import { createClient } from "@supabase/supabase-js";
import buddypopLogo from "./img/buddypop-logo.png";
import qrcodeImg from "./img/qrcode.png";
import { sfx, startBgm, startLobbyBgm, ensureAudio, toggleMute, isMuted, stopJingle } from "./sound";

// ============================================================
// ⚙️  Supabase 정보는 .env 파일 / Vercel 환경변수에서 읽어옵니다
// ============================================================
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
// ============================================================

const COLS = 8;
const ROWS = 10;

// 그리드 레이아웃 (이펙트 좌표 계산과 공유)
const CELL_SIZE = 36;
const CELL_GAP = 3;
const CELL_STRIDE = CELL_SIZE + CELL_GAP;
const GRID_PADDING = 6;
const COLORS = ["#FF6B9D", "#FF9F43", "#FECA57", "#48DBFB", "#FF6B6B", "#A29BFE"];
const COLOR_EMOJIS = ["🌸", "🍊", "⭐", "💎", "❤️", "🔮"];
const PLAYER_COLORS = ["#FF6B9D", "#48DBFB", "#FECA57", "#A29BFE", "#FF9F43", "#FF6B6B"];
const PLAYER_EMOJIS = ["🐰", "🐱", "🐸", "🦊", "🐼", "🐨"];

const LEVEL_CONFIG = [
  { target: 2000,  moves: 20, label: "Level 1" },
  { target: 4000,  moves: 20, label: "Level 2" },
  { target: 6000, moves: 20, label: "Level 3" },
  { target: 8000, moves: 20, label: "Level 4" },
  { target: 10000, moves: 20, label: "Level 5" },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const POLL_MS = 800;

function roomTimestamp(room) {
  return Date.parse(room?.updated_at || 0) || 0;
}

/** 서버 방 상태를 로컬에 병합 (플레이어 입장·동시 플레이 반영) */
function mergeRemoteRoom(remote, prev) {
  if (!remote) return prev;
  if (!prev) return remote;

  if (JSON.stringify(remote.players) !== JSON.stringify(prev.players)) return remote;

  const remoteTs = roomTimestamp(remote);
  const prevTs = roomTimestamp(prev);
  if (remoteTs <= prevTs) return prev;

  const gameChanged =
    remote.score !== prev.score ||
    remote.moves !== prev.moves ||
    remote.level !== prev.level ||
    remote.max_levels !== prev.max_levels ||
    remote.combo !== prev.combo ||
    remote.game_state !== prev.game_state ||
    JSON.stringify(remote.grid) !== JSON.stringify(prev.grid);

  return gameChanged ? remote : prev;
}

// ── Supabase REST helpers ──────────────────────────────────
async function sbFetch(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...rest,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getRoom(id) {
  const rows = await sbFetch(`/game_rooms?id=eq.${id}`);
  return rows?.[0] || null;
}

async function upsertRoom(data) {
  return sbFetch("/game_rooms", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(data),
  });
}

async function updateRoom(id, patch) {
  const rows = await sbFetch(`/game_rooms?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── Game logic ────────────────────────────────────────────
function randomColor() { return Math.floor(Math.random() * COLORS.length); }

function createGrid() {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => randomColor())
  );
}

// 같은 색으로 연결된 칸들을 반복(스택) 방식으로 탐색 — 재귀/배열 spread 비용 제거
function floodFind(grid, row, col, color) {
  if (color === null) return [];
  const visited = new Set();
  const result = [];
  const stack = [[row, col]];
  while (stack.length) {
    const [r, c] = stack.pop();
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
    const key = r * COLS + c;
    if (visited.has(key) || grid[r][c] !== color) continue;
    visited.add(key);
    result.push([r, c]);
    stack.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
  }
  return result;
}

function applyGravity(grid) {
  const result = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (let c = 0; c < COLS; c++) {
    const column = [];
    for (let r = 0; r < ROWS; r++) if (grid[r][c] !== null) column.push(grid[r][c]);
    const offset = ROWS - column.length;
    column.forEach((v, i) => { result[offset + i][c] = v; });
  }
  return result;
}

function generateRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ── 단일 셀 (memo) — colorIdx/shake가 바뀐 칸만 리렌더 ─────
const Cell = memo(function Cell({ row, col, colorIdx, shake, onClick }) {
  const filled = colorIdx !== null;
  return (
    <button
      className="cell-btn"
      onClick={() => onClick(row, col)}
      style={{
        width: CELL_SIZE, height: CELL_SIZE, borderRadius: 9,
        border: "none",
        cursor: filled ? "pointer" : "default",
        background: filled
          ? `radial-gradient(circle at 35% 35%, ${COLORS[colorIdx]}ee, ${COLORS[colorIdx]}88)`
          : "rgba(255,255,255,0.03)",
        fontSize: 17,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "transform 0.1s, filter 0.1s",
        boxShadow: filled
          ? `0 4px 10px ${COLORS[colorIdx]}55, inset 0 1px 0 rgba(255,255,255,0.4)`
          : "none",
        animation: shake ? "shake 0.4s" : "none",
        padding: 0,
      }}
    >
      {filled ? COLOR_EMOJIS[colorIdx] : ""}
    </button>
  );
});

// ── 음소거 토글 버튼 (우측 상단 고정) ─────────────────────
function MuteButton() {
  const [muted, setMuted] = useState(isMuted());
  return (
    <button
      type="button"
      onClick={() => { ensureAudio(); setMuted(toggleMute()); }}
      aria-label={muted ? "소리 켜기" : "소리 끄기"}
      style={{
        position: "fixed", top: 12, right: 12, zIndex: 400,
        width: 40, height: 40, borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(0,0,0,0.35)",
        color: "white", fontSize: 18, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(6px)", padding: 0,
      }}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

// ── 단계 선택 팝업 (새 방 만들기) ─────────────────────────
function StagePickerModal({ stages, onChange, onStart, onCancel }) {
  const dec = () => { sfx.click(); onChange(Math.max(1, stages - 1)); };
  const inc = () => { sfx.click(); onChange(Math.min(5, stages + 1)); };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300,
      background: "rgba(0,0,0,0.8)",
      display: "flex", alignItems: "center", justifyContent: "center",
      backdropFilter: "blur(8px)",
    }}>
      <div style={{
        background: "linear-gradient(135deg, #2d1052, #0d2060)",
        border: "2px solid rgba(255,255,255,0.2)",
        borderRadius: 24, padding: "32px 28px",
        textAlign: "center", width: "min(320px, 90vw)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
      }}>
        <div style={{ color: "#FECA57", fontSize: 18, fontWeight: 900, marginBottom: 8 }}>
          진행 단계 선택
        </div>
        <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginBottom: 24 }}>
          몇 단계로 진행할까요?
        </p>

        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 20,
          marginBottom: 28,
        }}>
          <button
            type="button"
            onClick={dec}
            disabled={stages <= 1}
            aria-label="단계 줄이기"
            style={arrowBtnStyle(stages <= 1)}
          >
            ‹
          </button>
          <div style={{
            minWidth: 72, fontSize: 56, fontWeight: 900, color: "white", lineHeight: 1,
          }}>
            {stages}
          </div>
          <button
            type="button"
            onClick={inc}
            disabled={stages >= 5}
            aria-label="단계 늘리기"
            style={arrowBtnStyle(stages >= 5)}
          >
            ›
          </button>
        </div>

        <button type="button" onClick={() => { sfx.click(); onStart(); }} style={{ ...btnStyle("#FF6B9D", true), marginBottom: 8 }}>
          게임시작
        </button>
        <button
          type="button"
          onClick={() => { sfx.click(); onCancel(); }}
          style={{
            background: "transparent", border: "none", color: "rgba(255,255,255,0.45)",
            fontSize: 13, cursor: "pointer", padding: "8px 16px",
          }}
        >
          취소
        </button>
      </div>
    </div>
  );
}

function arrowBtnStyle(disabled) {
  return {
    width: 48, height: 48, borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.25)",
    background: disabled ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.12)",
    color: disabled ? "rgba(255,255,255,0.25)" : "white",
    fontSize: 28, fontWeight: 700, lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 0,
  };
}

// ── Lobby Screen ──────────────────────────────────────────
function Lobby({ onCreate, onJoin }) {
  const [joinId, setJoinId] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [showStagePicker, setShowStagePicker] = useState(false);
  const [stageCount, setStageCount] = useState(1);

  // 브라우저 자동재생 정책상 첫 사용자 동작(클릭·입력) 후에 로비 음악 시작
  useEffect(() => {
    const start = () => { ensureAudio(); startLobbyBgm(); };
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, []);

  const handleJoin = async () => {
    ensureAudio();
    sfx.click();
    if (!nickname.trim()) { setError("닉네임을 입력해주세요"); return; }
    if (!joinId.trim()) { setError("방 코드를 입력해주세요"); return; }
    const room = await getRoom(joinId.toUpperCase().trim()).catch(() => null);
    if (!room) { setError("존재하지 않는 방이에요"); return; }
    onJoin(joinId.toUpperCase().trim(), nickname.trim());
  };

  const openStagePicker = () => {
    ensureAudio();
    sfx.click();
    if (!nickname.trim()) { setError("닉네임을 입력해주세요"); return; }
    setError("");
    setStageCount(1);
    setShowStagePicker(true);
  };

  const startGame = () => {
    setShowStagePicker(false);
    onCreate(nickname.trim(), stageCount);
  };

  return (
    <div style={lobbyWrap}>
      <style>{globalStyle}</style>
      <MuteButton />
      <img
        src={buddypopLogo}
        alt="BUDDY POP"
        style={{ width: "100%", maxWidth: 320, marginBottom: 24, filter: "drop-shadow(0 4px 24px rgba(255,107,157,0.5))" }}
      />

      <input
        placeholder="닉네임 입력"
        value={nickname}
        onChange={e => setNickname(e.target.value)}
        style={inputStyle}
        maxLength={12}
      />

      <button onClick={openStagePicker} style={btnStyle("#FF6B9D", true)}>
        🏠 새 방 만들기
      </button>

      {showStagePicker && (
        <StagePickerModal
          stages={stageCount}
          onChange={setStageCount}
          onStart={startGame}
          onCancel={() => setShowStagePicker(false)}
        />
      )}

      <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 12, margin: "12px 0" }}>── 또는 ──</div>

      <input
        placeholder="방 코드 입력 (예: AB12C)"
        value={joinId}
        onChange={e => setJoinId(e.target.value.toUpperCase())}
        style={{ ...inputStyle, letterSpacing: 4, textAlign: "center" }}
        maxLength={5}
      />
      <button onClick={handleJoin} style={btnStyle("#48DBFB", true)}>
        🚀 방 참가하기
      </button>

      {error && <p style={{ color: "#FF6B6B", fontSize: 13, marginTop: 12 }}>{error}</p>}

      <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 11, marginTop: 24, textAlign: "center", maxWidth: 280 }}>
        같은 방 코드로 접속하면 모든 플레이어가<br/>실시간으로 같은 화면을 공유합니다
      </p>

      <div style={{
        marginTop: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}>
        <div style={{
          padding: 10,
          borderRadius: 16,
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 8px 28px rgba(255,107,157,0.4), inset 0 0 0 1px rgba(255,255,255,0.15)",
        }}>
          <img
            src={qrcodeImg}
            alt="BUDDY POP 접속 QR 코드"
            width={96}
            height={96}
            style={{ display: "block", width: 96, height: 96 }}
          />
        </div>
        <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, textAlign: "center" }}>
          스마트폰으로 스캔하여 플레이
        </p>
      </div>
    </div>
  );
}

// ── Main Game ─────────────────────────────────────────────
function Game({ roomId, playerId, playerName, playerIdx, maxLevels: maxLevelsProp }) {
  const [gameData, setGameData] = useState(null);
  const [popEffects, setPopEffects] = useState([]);
  const [popLabels, setPopLabels] = useState([]);
  const [comboEffect, setComboEffect] = useState(null);
  const [shakeCell, setShakeCell] = useState(null);
  const [copied, setCopied] = useState(false);
  const lockRef = useRef(false);
  const effectId = useRef(0);
  const lastPopSeenRef = useRef(null);
  // 최신 gameData를 ref로 추적 → handleClick을 안정적인 콜백으로 유지(셀 메모 가능)
  const gameDataRef = useRef(gameData);
  useEffect(() => { gameDataRef.current = gameData; }, [gameData]);

  const triggerPop = useCallback((cells, colorIdx, popperName = null) => {
    const id = ++effectId.current;
    const effects = cells.map(([r, c]) => ({
      id: `${id}-${r}-${c}`, row: r, col: c,
      color: COLORS[colorIdx], emoji: COLOR_EMOJIS[colorIdx],
    }));
    setPopEffects(prev => [...prev, ...effects]);
    const effectIds = new Set(effects.map(e => e.id));
    setTimeout(
      () => setPopEffects(prev => prev.filter(e => !effectIds.has(e.id))),
      600,
    );

    if (popperName && cells.length > 0) {
      const avgR = cells.reduce((s, [r]) => s + r, 0) / cells.length;
      const avgC = cells.reduce((s, [, c]) => s + c, 0) / cells.length;
      const labelId = `label-${id}`;
      setPopLabels(prev => [...prev, { id: labelId, row: avgR, col: avgC, name: popperName }]);
      setTimeout(() => setPopLabels(prev => prev.filter(l => l.id !== labelId)), 900);
    }
  }, []);

  const applyRemote = useCallback((remote) => {
    const lp = remote?.last_pop;
    if (lp?.player_id && lp.player_id !== playerId && lp.cells?.length >= 2) {
      const key = lp.at ?? `${lp.player_id}-${remote.updated_at}`;
      if (lastPopSeenRef.current !== key) {
        lastPopSeenRef.current = key;
        sfx.pop(lp.cells.length, 0.55);
        triggerPop(lp.cells, lp.color ?? 0, lp.name || "플레이어");
      }
    }
    setGameData(prev => mergeRemoteRoom(remote, prev));
  }, [playerId, triggerPop]);

  // Init: load or create room
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    const init = async () => {
      setInitError(null);
      try {
        let room = await getRoom(roomId).catch(() => null);
        if (!room) {
          const newRoom = {
            id: roomId,
            grid: createGrid(),
            score: 0,
            moves: LEVEL_CONFIG[0].moves,
            level: 0,
            combo: 0,
            max_levels: maxLevelsProp ?? LEVEL_CONFIG.length,
            players: [{ id: playerId, name: playerName, idx: playerIdx, score: 0 }],
            game_state: "playing",
            updated_at: new Date().toISOString(),
          };
          const created = await upsertRoom(newRoom);
          setGameData(Array.isArray(created) ? created[0] : newRoom);
        } else {
          const players = room.players || [];
          if (!players.find(p => p.id === playerId)) {
            const updated = [...players, { id: playerId, name: playerName, idx: playerIdx, score: 0 }];
            const patched = await updateRoom(roomId, { players: updated });
            room = patched || { ...room, players: updated };
          }
          setGameData(room);
        }
      } catch (e) {
        console.error("방 초기화 실패:", e);
        setInitError(e?.message || String(e));
      }
    };
    init();
  }, [roomId, playerId, playerName, playerIdx, maxLevelsProp]);

  // Realtime + 폴링 (Realtime 미설정 시에도 동기화 보장)
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      const room = await getRoom(roomId).catch(() => null);
      if (room) applyRemote(room);
    };

    const channel = supabase
      .channel(`game_room:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_rooms", filter: `id=eq.${roomId}` },
        (payload) => {
          const record = payload.new;
          if (record) applyRemote(record);
        }
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") poll();
        if (status === "CHANNEL_ERROR") console.warn("Realtime 구독 오류, 폴링으로 동기화:", err);
      });

    poll();
    const timer = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, [roomId, applyRemote]);

  // 게임 상태 전환 시 징글 (로컬·원격 모두 반영)
  const prevStateRef = useRef("playing");
  useEffect(() => {
    const st = gameData?.game_state;
    if (!st || st === prevStateRef.current) return;
    prevStateRef.current = st;
    stopJingle(); // 이전 징글(예: 승리 벨)이 남아 울리지 않도록 먼저 중단
    if (st === "levelup") sfx.levelup();
    else if (st === "win") sfx.win();
    else if (st === "gameover") sfx.gameover();
  }, [gameData?.game_state]);

  const handleClick = useCallback(async (row, col) => {
    const gameData = gameDataRef.current;
    if (!gameData || gameData.game_state !== "playing") return;
    if (lockRef.current) return;
    lockRef.current = true;

    const grid = gameData.grid;
    const color = grid[row][col];
    if (color === null) { lockRef.current = false; return; }

    const connected = floodFind(grid, row, col, color);

    if (connected.length < 2) {
      sfx.invalid();
      setShakeCell(`${row},${col}`);
      setTimeout(() => setShakeCell(null), 400);
      lockRef.current = false;
      return;
    }

    sfx.pop(connected.length);
    triggerPop(connected, color);

    const newGrid = grid.map(r => [...r]);
    connected.forEach(([r, c]) => { newGrid[r][c] = null; });
    const settled = applyGravity(newGrid);

    const pts = connected.length * connected.length * 10;
    const newCombo = (gameData.combo || 0) + 1;
    const comboMulti = newCombo >= 3 ? newCombo : 1;
    const total = pts * comboMulti;
    const newScore = (gameData.score || 0) + total;
    const newMoves = (gameData.moves || 0) - 1;
    const level = gameData.level || 0;
    const maxLevels = gameData.max_levels ?? LEVEL_CONFIG.length;
    const cfg = LEVEL_CONFIG[level];
    const lastLevel = maxLevels - 1;

    if (newCombo >= 2) {
      sfx.combo(newCombo);
      setComboEffect({ combo: newCombo, pts: total, id: Date.now() });
      setTimeout(() => setComboEffect(null), 1000);
    }

    // Update player contribution
    const players = (gameData.players || []).map(p =>
      p.id === playerId ? { ...p, score: (p.score || 0) + total } : p
    );

    let newState = "playing";
    if (newScore >= cfg.target && level < lastLevel) newState = "levelup";
    else if (newScore >= cfg.target && level >= lastLevel) newState = "win";
    else if (newMoves <= 0 && newScore < cfg.target) newState = "gameover";

    const patch = {
      grid: settled,
      score: newScore,
      moves: newMoves,
      combo: newCombo,
      players,
      game_state: newState,
      last_pop: {
        player_id: playerId,
        name: playerName,
        cells: connected,
        color,
        at: Date.now(),
      },
    };

    setGameData(prev => ({ ...prev, ...patch, updated_at: new Date().toISOString() }));
    const saved = await updateRoom(roomId, patch).catch(() => null);
    if (saved) setGameData(saved);
    lockRef.current = false;
  }, [playerId, playerName, roomId, triggerPop]);

  const handleNextLevel = async () => {
    stopJingle();
    const maxLevels = gameData.max_levels ?? LEVEL_CONFIG.length;
    const nl = (gameData.level || 0) + 1;
    if (nl >= maxLevels) return;
    const patch = {
      grid: createGrid(),
      moves: LEVEL_CONFIG[nl].moves,
      level: nl,
      combo: 0,
      game_state: "playing",
      last_pop: null,
    };
    const saved = await updateRoom(roomId, patch);
    if (saved) setGameData(saved);
  };

  const handleRestart = async () => {
    stopJingle();
    const patch = {
      grid: createGrid(),
      score: 0,
      moves: LEVEL_CONFIG[0].moves,
      level: 0,
      combo: 0,
      max_levels: gameData.max_levels ?? LEVEL_CONFIG.length,
      game_state: "playing",
      players: (gameData.players || []).map(p => ({ ...p, score: 0 })),
      last_pop: null,
    };
    const saved = await updateRoom(roomId, patch);
    if (saved) setGameData(saved);
  };

  const copyRoomCode = () => {
    sfx.click();
    navigator.clipboard?.writeText(roomId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!gameData) {
    return (
      <div style={{ ...lobbyWrap, justifyContent: "center" }}>
        {initError ? (
          <>
            <div style={{ color: "#FF6B6B", fontSize: 18, marginBottom: 12 }}>방 접속 실패</div>
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, maxWidth: 320, textAlign: "center" }}>{initError}</p>
          </>
        ) : (
          <div style={{ color: "white", fontSize: 20 }}>🔄 방에 접속 중...</div>
        )}
      </div>
    );
  }

  const { grid, score, moves, level, combo, players, game_state, max_levels: maxLevels } = gameData;
  const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[LEVEL_CONFIG.length - 1];
  const stageTotal = maxLevels ?? LEVEL_CONFIG.length;
  const progress = Math.min((score / cfg.target) * 100, 100);
  const myColor = PLAYER_COLORS[playerIdx % PLAYER_COLORS.length];
  const winner = (players || []).reduce((best, p) => {
    if (!best || (p.score || 0) > (best.score || 0)) return p;
    return best;
  }, null);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #1a0533 0%, #2d1052 40%, #0d2060 100%)",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "flex-start",
      fontFamily: "'Segoe UI', sans-serif",
      padding: "12px 16px",
      overflowX: "hidden",
    }}>
      <style>{globalStyle}</style>
      <MuteButton />

      {/* Room code bar */}
      <div style={{
        width: "100%", maxWidth: 420,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 8,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>방 코드</span>
          <button onClick={copyRoomCode} style={{
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#FECA57", fontWeight: 900, fontSize: 14,
            padding: "3px 10px", borderRadius: 8, cursor: "pointer",
            letterSpacing: 3,
          }}>
            {roomId}
          </button>
          {copied && <span style={{ color: "#48DBFB", fontSize: 11 }}>✓ 복사됨</span>}
        </div>
        <div style={{ color: "#FECA57", fontSize: 12, fontWeight: 700 }}>
          {cfg.label} · {level + 1}/{stageTotal}
        </div>
      </div>

      {/* Players */}
      <div style={{
        width: "100%", maxWidth: 420,
        display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap",
      }}>
        {(players || []).map((p) => (
          <div key={p.id} style={{
            background: p.id === playerId
              ? `${PLAYER_COLORS[p.idx % PLAYER_COLORS.length]}33`
              : "rgba(255,255,255,0.06)",
            border: `1px solid ${p.id === playerId ? PLAYER_COLORS[p.idx % PLAYER_COLORS.length] : "rgba(255,255,255,0.1)"}`,
            borderRadius: 10, padding: "4px 10px",
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ fontSize: 14 }}>{PLAYER_EMOJIS[p.idx % PLAYER_EMOJIS.length]}</span>
            <span style={{ color: "white", fontSize: 11, fontWeight: 600 }}>{p.name}</span>
            <span style={{ color: PLAYER_COLORS[p.idx % PLAYER_COLORS.length], fontSize: 11, fontWeight: 700 }}>
              +{(p.score || 0).toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Score panel */}
      <div style={{
        width: "100%", maxWidth: 420,
        background: "rgba(255,255,255,0.08)",
        borderRadius: 16, padding: "10px 16px", marginBottom: 8,
        backdropFilter: "blur(10px)",
        border: "1px solid rgba(255,255,255,0.12)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>TEAM SCORE</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: "#FECA57", lineHeight: 1 }}>
              {(score || 0).toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>TARGET</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#48DBFB" }}>
              {cfg.target.toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>MOVES</div>
            <div style={{
              fontSize: 26, fontWeight: 900, lineHeight: 1,
              color: (moves || 0) <= 3 ? "#FF6B6B" : "#A29BFE",
              animation: (moves || 0) <= 3 ? "pulse 0.8s infinite" : "none",
            }}>{moves || 0}</div>
          </div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 8, height: 7, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 8, width: `${progress}%`,
            background: "linear-gradient(90deg, #FF6B9D, #FECA57)",
            transition: "width 0.4s ease", boxShadow: "0 0 10px #FF6B9D",
          }} />
        </div>
      </div>

      {/* Combo */}
      {(combo || 0) >= 2 && (
        <div style={{
          color: "#FECA57", fontWeight: 900, fontSize: 13,
          marginBottom: 4, letterSpacing: 3,
          textShadow: "0 0 12px #FECA57",
          animation: "pulse 0.5s infinite",
        }}>🔥 {combo}x COMBO</div>
      )}

      {/* Grid */}
      <div style={{
        position: "relative",
        background: "rgba(0,0,0,0.3)",
        borderRadius: 20, padding: GRID_PADDING,
        border: "2px solid rgba(255,255,255,0.1)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLS}, ${CELL_SIZE}px)`,
          gridTemplateRows: `repeat(${ROWS}, ${CELL_SIZE}px)`,
          gap: CELL_GAP,
        }}>
          {(grid || createGrid()).map((row, ri) =>
            row.map((colorIdx, ci) => {
              const key = `${ri},${ci}`;
              return (
                <Cell
                  key={key}
                  row={ri}
                  col={ci}
                  colorIdx={colorIdx}
                  shake={shakeCell === key}
                  onClick={handleClick}
                />
              );
            })
          )}
        </div>

        {/* Pop effects */}
        {popEffects.map(ef => (
          <div key={ef.id} style={{
            position: "absolute",
            left: GRID_PADDING + ef.col * CELL_STRIDE + CELL_SIZE / 2,
            top: GRID_PADDING + ef.row * CELL_STRIDE + CELL_SIZE / 2,
            transform: "translate(-50%, -50%)",
            fontSize: 20, pointerEvents: "none",
            animation: "popBurst 0.6s forwards",
            zIndex: 10,
          }}>{ef.emoji}</div>
        ))}
        {popLabels.map(lb => (
          <div key={lb.id} style={{
            position: "absolute",
            left: GRID_PADDING + lb.col * CELL_STRIDE + CELL_SIZE / 2,
            top: GRID_PADDING + lb.row * CELL_STRIDE + CELL_SIZE / 2,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 20,
            animation: "popBurst 0.6s forwards",
          }}>
            <span style={{
              display: "inline-block",
              background: "rgba(0,0,0,0.75)",
              color: "#FECA57",
              fontSize: 12,
              fontWeight: 900,
              padding: "4px 10px",
              borderRadius: 10,
              border: "1px solid rgba(254,202,87,0.5)",
              whiteSpace: "nowrap",
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}>
              {lb.name}
            </span>
          </div>
        ))}
      </div>

      {/* Combo popup */}
      {comboEffect && (
        <div key={comboEffect.id} style={{
          position: "fixed", top: "40%", left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center", pointerEvents: "none", zIndex: 100,
          animation: "comboSlam 0.4s forwards, fadeCombo 0.6s 0.4s forwards",
        }}>
          <div style={{ fontSize: 44, fontWeight: 900, color: "#FECA57", textShadow: "0 0 30px #FECA57" }}>
            {comboEffect.combo}x COMBO!
          </div>
          <div style={{ fontSize: 22, color: "white", fontWeight: 700 }}>+{comboEffect.pts}</div>
        </div>
      )}

      {/* My info badge */}
      <div style={{
        marginTop: 8,
        background: `${myColor}22`,
        border: `1px solid ${myColor}66`,
        borderRadius: 12, padding: "5px 14px",
        color: myColor, fontSize: 12, fontWeight: 700,
      }}>
        {PLAYER_EMOJIS[playerIdx % PLAYER_EMOJIS.length]} {playerName} (나)
      </div>

      {/* Overlay */}
      {game_state !== "playing" && (
        <div style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.8)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 200, backdropFilter: "blur(8px)",
        }}>
          <div style={{
            background: "linear-gradient(135deg, #2d1052, #0d2060)",
            border: "2px solid rgba(255,255,255,0.2)",
            borderRadius: 28, padding: "36px 44px",
            textAlign: "center", maxWidth: 320,
            animation: "levelUp 0.5s forwards",
          }}>
            {game_state === "levelup" && (
              <>
                <div style={{ fontSize: 56 }}>🎉</div>
                <div style={{ color: "#FECA57", fontSize: 28, fontWeight: 900, marginBottom: 6 }}>LEVEL UP!</div>
                <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 20 }}>
                  팀 점수 {(score||0).toLocaleString()} 달성!
                </div>
                <button onClick={() => { sfx.click(); handleNextLevel(); }} style={btnStyle("#FF6B9D")}>
                  NEXT LEVEL →
                </button>
              </>
            )}
            {game_state === "win" && (
              <>
                <div style={{ fontSize: 56 }}>🏆</div>
                <div style={{ color: "#FECA57", fontSize: 28, fontWeight: 900, marginBottom: 6 }}>
                  &quot;{winner?.name || playerName}&quot; 승리!
                </div>
                <div style={{ color: "white", fontSize: 18, marginBottom: 16 }}>
                  {(winner?.score || 0).toLocaleString()} pts
                </div>
                <button onClick={() => { sfx.click(); handleRestart(); }} style={btnStyle("#48DBFB")}>다시 플레이</button>
              </>
            )}
            {game_state === "gameover" && (
              <>
                <div style={{ fontSize: 56 }}>😢</div>
                <div style={{ color: "#FF6B6B", fontSize: 28, fontWeight: 900, marginBottom: 6 }}>GAME OVER</div>
                <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginBottom: 20 }}>
                  목표 {cfg.target.toLocaleString()} pts 미달
                </div>
                <button onClick={() => { sfx.click(); handleRestart(); }} style={btnStyle("#FF6B9D")}>다시 도전</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── App root ──────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("lobby");
  const [roomId, setRoomId] = useState("");
  const [playerId] = useState(() => `player_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const [playerName, setPlayerName] = useState("");
  const [playerIdx, setPlayerIdx] = useState(0);

  const [maxLevels, setMaxLevels] = useState(LEVEL_CONFIG.length);

  const handleCreate = (name, totalStages = 1) => {
    ensureAudio();
    startBgm();
    const id = generateRoomId();
    setRoomId(id);
    setPlayerName(name);
    setPlayerIdx(0);
    setMaxLevels(Math.min(5, Math.max(1, totalStages)));
    setScreen("game");
  };

  const handleJoin = async (id, name) => {
    ensureAudio();
    startBgm();
    const room = await getRoom(id).catch(() => null);
    const idx = room ? (room.players || []).length : 1;
    setRoomId(id);
    setPlayerName(name);
    setPlayerIdx(idx);
    setMaxLevels(room?.max_levels ?? LEVEL_CONFIG.length);
    setScreen("game");
  };

  if (screen === "lobby") return <Lobby onCreate={handleCreate} onJoin={handleJoin} />;
  return (
    <Game
      roomId={roomId}
      playerId={playerId}
      playerName={playerName}
      playerIdx={playerIdx}
      maxLevels={maxLevels}
    />
  );
}

// ── Shared styles ─────────────────────────────────────────
const lobbyWrap = {
  minHeight: "100vh",
  background: "linear-gradient(135deg, #1a0533 0%, #2d1052 40%, #0d2060 100%)",
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  fontFamily: "'Segoe UI', sans-serif", padding: "24px 16px",
};

const inputStyle = {
  width: "100%", maxWidth: 300,
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 14, padding: "12px 16px",
  color: "white", fontSize: 16,
  outline: "none", marginBottom: 10,
  boxSizing: "border-box",
};

function btnStyle(color, full) {
  return {
    width: full ? "100%" : "auto",
    maxWidth: full ? 300 : "auto",
    background: `linear-gradient(135deg, ${color}, ${color}aa)`,
    color: "white", border: "none",
    borderRadius: 14, padding: "13px 28px",
    fontSize: 16, fontWeight: 900,
    cursor: "pointer", letterSpacing: 1,
    boxShadow: `0 8px 24px ${color}55`,
    marginBottom: full ? 4 : 0,
  };
}

const globalStyle = `
  @keyframes twinkle { from { opacity: 0.2 } to { opacity: 0.9 } }
  @keyframes popBurst {
    0% { transform: scale(1); opacity: 1; }
    50% { transform: scale(2.2); opacity: 0.8; }
    100% { transform: scale(0); opacity: 0; }
  }
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    25% { transform: translateX(-4px) rotate(-5deg); }
    75% { transform: translateX(4px) rotate(5deg); }
  }
  @keyframes comboSlam {
    0% { transform: translate(-50%,-50%) scale(0.3) rotate(-10deg); opacity: 0; }
    60% { transform: translate(-50%,-50%) scale(1.2) rotate(3deg); opacity: 1; }
    100% { transform: translate(-50%,-50%) scale(1) rotate(0deg); opacity: 1; }
  }
  @keyframes fadeCombo {
    0% { opacity: 1; transform: translate(-50%,-50%) translateY(0) scale(1); }
    100% { opacity: 0; transform: translate(-50%,-50%) translateY(-30px) scale(0.8); }
  }
  @keyframes pulse {
    0%,100% { transform: scale(1); }
    50% { transform: scale(1.06); }
  }
  @keyframes levelUp {
    0% { transform: scale(0.5) rotate(-5deg); opacity: 0; }
    70% { transform: scale(1.1) rotate(2deg); opacity: 1; }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  .cell-btn:hover { transform: scale(1.12); filter: brightness(1.2); }
  .cell-btn:active { transform: scale(0.9); }
  input::placeholder { color: rgba(255,255,255,0.3); }
`;
