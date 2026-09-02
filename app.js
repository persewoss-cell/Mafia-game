/* ============================================================
   마피아 게임 - app.js
   Firebase Firestore를 이용한 실시간 동기화 로직
   ============================================================ */

if (typeof firebase === "undefined") {
  if (window.showFatalError) {
    showFatalError("Firebase 라이브러리가 로드되지 않았습니다. 인터넷 연결 또는 네트워크 차단 설정을 확인해주세요.");
  }
  throw new Error("firebase SDK not loaded");
}
if (typeof firebaseConfig === "undefined" || firebaseConfig.apiKey === "YOUR_API_KEY") {
  if (window.showFatalError) {
    showFatalError("firebase-config.js에 실제 Firebase 프로젝트 값이 입력되지 않았습니다.");
  }
  throw new Error("firebaseConfig not set");
}

let db;
try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
} catch (err) {
  if (window.showFatalError) {
    showFatalError("Firebase 초기화에 실패했습니다: " + err.message);
  }
  throw err;
}

const $ = (id) => document.getElementById(id);

// 결과 발표(reveal) 화면에서 다음 단계로 자동으로 넘어가기까지 기다리는 시간.
const REVEAL_COUNTDOWN_MS = 10000;
// 경찰 전원이 조사를 마친 뒤, 조사 결과를 읽을 시간을 주고 다음 단계로 넘어가기까지 기다리는 시간.
const POLICE_RESULT_DELAY_MS = 7000;

// 게임 진행(투표 마감, 다음 단계 이동 등) 관련 쓰기는 이 락을 통해서만 실행한다.
// 자동 진행 타이머와 관리자의 수동 버튼 클릭이 동시에 눌려도 같은 단계가
// 두 번 처리되지 않도록 막아준다.
let adminActionBusy = false;
async function runAdminAction(fn) {
  if (adminActionBusy) return;
  adminActionBusy = true;
  try {
    await fn();
  } finally {
    adminActionBusy = false;
  }
}

/* ------------------------------------------------------------
   화면 전환
   ------------------------------------------------------------ */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $(id).classList.add("active");
  const leaveBtn = $("btnLeaveTopRight");
  if (leaveBtn) leaveBtn.hidden = !(id === "screen-admin" || id === "screen-player");
  const endGameBtn = $("btnEndGameTopRight");
  if (endGameBtn) endGameBtn.hidden = id !== "screen-admin";
  if (id !== "screen-player") document.body.classList.remove("player-dead");

  // 브라우저 뒤로가기를 누르면 사이트를 벗어나지 않고 이전 화면으로 돌아가도록
  // 화면이 바뀔 때마다 히스토리에 기록해둔다. 이미 같은 화면이면 다시 쌓지 않는다.
  if (!history.state) {
    history.replaceState({ screen: id }, "", "#" + id);
  } else if (history.state.screen !== id) {
    history.pushState({ screen: id }, "", "#" + id);
  }
}

window.addEventListener("popstate", (e) => {
  const targetId = (e.state && e.state.screen) || "screen-home";
  const session = loadSession();

  if (targetId === "screen-admin" && session && session.role === "admin") {
    startAdminSession(session.code);
  } else if (targetId === "screen-player" && session && session.role === "player") {
    startPlayerSession(session.code, session.playerId);
  } else if (targetId === "screen-create") {
    enterCreateScreen();
  } else {
    showScreen(targetId);
  }
});

function setTheme(phase) {
  document.body.classList.toggle("theme-night", phase === "night");
}

/* ------------------------------------------------------------
   세션 저장 (새로고침해도 자동으로 다시 들어가도록)
   ------------------------------------------------------------ */
const SESSION_KEY = "mafiaGameSession";

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch (e) {
    return null;
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ------------------------------------------------------------
   유틸
   ------------------------------------------------------------ */
function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 3~6명은 역할이 한쪽으로 쏠리지 않도록 고정 배정을 쓴다.
// 7명부터는 마피아 = floor(총원/3), 의사 = floor(남은 인원/5), 경찰 = round(의사/2),
// 시민 = 나머지. (마피아·의사는 버림, 경찰만 반올림)
function computeRoleCounts(total) {
  if (total === 3) return { mafiaCount: 1, doctorCount: 1, policeCount: 0, citizenCount: 1 };
  if (total === 4) return { mafiaCount: 1, doctorCount: 1, policeCount: 1, citizenCount: 1 };
  if (total === 5) return { mafiaCount: 1, doctorCount: 1, policeCount: 1, citizenCount: 2 };
  if (total === 6) return { mafiaCount: 1, doctorCount: 1, policeCount: 1, citizenCount: 3 };

  const mafiaCount = Math.floor(total / 3);
  const remaining = total - mafiaCount;
  const doctorCount = Math.floor(remaining / 5);
  const policeCount = Math.round(doctorCount / 2);
  const citizenCount = Math.max(0, remaining - doctorCount - policeCount);
  return { mafiaCount, doctorCount, policeCount, citizenCount };
}

function roleLabel(role) {
  if (role === "mafia") return "마피아";
  if (role === "doctor") return "의사";
  if (role === "police") return "경찰";
  return "시민";
}
function roleEmoji(role) {
  if (role === "mafia") return "🔪";
  if (role === "doctor") return "💉";
  if (role === "police") return "🔍";
  return "🙂";
}

function aliveList(players) {
  return players.filter((p) => p.alive);
}
function countByRole(players, role) {
  return players.filter((p) => p.alive && p.role === role).length;
}

/* ------------------------------------------------------------
   홈 화면
   ------------------------------------------------------------ */
$("btnGoCreate").addEventListener("click", () => {
  enterCreateScreen();
});

function enterCreateScreen() {
  $("createError").textContent = "";
  $("inputMaxPlayers").value = "";
  $("inputAdminPin").value = "";
  $("reconnectError").textContent = "";
  $("inputReconnectCode").value = "";
  $("inputReconnectPin").value = "";
  // 이전에 게임을 한 번 만든 뒤에는 제출 버튼이 계속 비활성 상태로 남아있으므로,
  // 이 화면에 들어올 때마다 다시 눌러지도록 초기화한다.
  $("btnCreateGame").disabled = false;
  renderAdminHistoryList();
  renderAdminOpenRoomsList();
  showScreen("screen-create");
}
$("btnGoJoin").addEventListener("click", () => enterJoinScreen());

function enterJoinScreen() {
  $("joinError").textContent = "";
  $("inputCode").value = "";
  $("inputName").value = "";
  // 이전에 참가에 성공한 뒤에는 제출 버튼이 계속 비활성 상태로 남아있으므로,
  // 이 화면에 들어올 때마다 다시 눌러지도록 초기화한다.
  $("btnJoinGame").disabled = false;
  renderOpenRoomsList();
  showScreen("screen-join");
}

// 아직 게임이 시작되지 않은(대기실 상태) 방 목록을 Firestore에서 최신순으로 가져온다.
async function fetchOpenLobbyRooms(limit = 10) {
  const snap = await db.collection("games").where("status", "==", "lobby").get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, limit);
}

// 참가 화면용: 대기실뿐 아니라 이미 진행 중인 방도 함께 보여준다. 중간에 튕긴
// 참가자가 코드를 몰라도 쉽게 다시 들어올 수 있도록 하기 위함이다. 진행 중인
// 방은 현재 참여 인원도 함께 보여줘야 하므로 참가자 수를 추가로 조회한다.
async function fetchJoinableRooms(limit = 10) {
  const snap = await db.collection("games").where("status", "in", ["lobby", "playing"]).get();
  const rooms = snap.docs
    .map((d) => d.data())
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, limit);

  await Promise.all(
    rooms.map(async (g) => {
      if (g.status !== "playing") return;
      try {
        const playersSnap = await db.collection("games").doc(g.code).collection("players").get();
        g.playerCount = playersSnap.size;
      } catch (e) {
        g.playerCount = null;
      }
    })
  );

  return rooms;
}

// 방 목록의 한 줄에 들어갈 안내 문구. 진행 중인 방은 "참여 인원: X명/총 Y명"을 보여준다.
function roomInfoText(g) {
  if (g.status === "playing") {
    const joined = g.playerCount === null || g.playerCount === undefined ? "?" : g.playerCount;
    return `🎮 진행중 · 참여 인원: ${joined}명/총 ${g.maxPlayers}명`;
  }
  return `최대 ${g.maxPlayers}명`;
}

// cardId/listId에 열려있는 방 목록을 렌더링한다. 방을 누르면 onPick(code)가 호출된다.
// onDelete가 있으면(관리자 화면) 방마다 삭제(🗑️) 버튼도 함께 보여준다.
async function renderOpenRoomsInto(cardId, listId, fetchFn, onPick, onDelete) {
  const card = $(cardId);
  const list = $(listId);
  if (!card || !list) return;

  card.hidden = true;
  list.innerHTML = "";

  try {
    const rooms = await fetchFn();
    if (rooms.length === 0) return;

    card.hidden = false;
    list.innerHTML = rooms
      .map(
        (g) =>
          `<li class="open-room-item" data-code="${g.code}">
            ${onDelete ? `<button type="button" class="delete-room-btn" data-code="${g.code}" title="방 삭제">🗑️</button>` : ""}
            🔑 ${g.code}<br><span class="sub-text">${roomInfoText(g)}</span>
          </li>`
      )
      .join("");

    list.querySelectorAll(".open-room-item").forEach((item) => {
      item.addEventListener("click", () => onPick(item.dataset.code));
    });

    if (onDelete) {
      list.querySelectorAll(".delete-room-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onDelete(btn.dataset.code);
        });
      });
    }
  } catch (err) {
    console.error(err);
    card.hidden = true;
  }
}

// 참가 화면: 방을 누르면 코드 입력란에 자동으로 채워진다. 대기실뿐 아니라
// 진행 중인 방도 보여줘서, 중간에 튕긴 참가자가 쉽게 다시 들어올 수 있게 한다.
function renderOpenRoomsList() {
  return renderOpenRoomsInto("openRoomsCard", "openRoomsList", fetchJoinableRooms, (code) => {
    $("inputCode").value = code;
    $("inputName").focus();
  });
}

// 관리자 화면: "최근에 만든 게임방"(이 브라우저 기록)과 달리, 다른 기기에서 만든
// 방을 포함해 현재 열려있는 대기실 전체를 보여준다. 누르면 관리자 비밀번호를
// 입력해 재접속을 시도하고, 휴지통 버튼으로 방을 완전히 삭제할 수도 있다.
function renderAdminOpenRoomsList() {
  return renderOpenRoomsInto(
    "adminOpenRoomsCard",
    "adminOpenRoomsList",
    fetchOpenLobbyRooms,
    (code) => {
      const pin = prompt(`${code}번 방 관리자 비밀번호(4자리)를 입력하세요.`);
      if (pin === null) return;
      attemptAdminReconnect(code, pin.trim(), null);
    },
    async (code) => {
      if (!confirm(`${code}번 방을 완전히 삭제하시겠습니까? 되돌릴 수 없습니다.`)) return;
      try {
        await deleteGameCompletely(code);
      } catch (err) {
        console.error(err);
        alert("방 삭제 중 오류가 발생했습니다: " + err.message);
        return;
      }
      removeAdminHistory(code);
      renderAdminHistoryList();
      renderAdminOpenRoomsList();
    }
  );
}
$("btnGoHowTo").addEventListener("click", () => showScreen("screen-howto"));
$("btnBackHome1").addEventListener("click", () => showScreen("screen-home"));
$("btnBackHome2").addEventListener("click", () => showScreen("screen-home"));
$("btnBackHome3").addEventListener("click", () => showScreen("screen-home"));

/* ------------------------------------------------------------
   게임 나가기 (화면 우측 상단 고정 버튼)
   ------------------------------------------------------------ */
$("btnLeaveTopRight").addEventListener("click", () => {
  const session = loadSession();
  const isAdmin = session && session.role === "admin";
  const msg = isAdmin
    ? "관리자가 나가면 자동 진행이 멈춰요. 게임에서 나가시겠어요? (게임 만들기 화면에서 코드+비밀번호로 다시 들어올 수 있어요)"
    : "게임에서 나가시겠어요? 같은 코드와 이름으로 다시 들어올 수 있어요.";
  if (!confirm(msg)) return;

  if (adminUnsubGame) adminUnsubGame();
  if (adminUnsubPlayers) adminUnsubPlayers();
  if (adminTickInterval) clearInterval(adminTickInterval);
  if (playerUnsubGame) playerUnsubGame();
  if (playerUnsubPlayers) playerUnsubPlayers();
  if (playerTickInterval) clearInterval(playerTickInterval);

  clearSession();
  showScreen("screen-home");
});

/* ------------------------------------------------------------
   게임 강제 종료 (관리자 전용, 나가기 버튼 옆 고정 버튼)
   ------------------------------------------------------------ */
$("btnEndGameTopRight").addEventListener("click", async () => {
  const session = loadSession();
  if (!session || session.role !== "admin") return;
  if (!confirm("정말로 게임을 강제 종료하시겠습니까? 모든 참가자가 자동으로 나가게 됩니다.")) return;

  try {
    await gameRef(session.code).update({ status: "terminated", revealDeadline: null });
  } catch (err) {
    console.error(err);
    alert("게임 종료 중 오류가 발생했습니다: " + err.message);
  }
});

/* ------------------------------------------------------------
   게임 생성 (관리자)
   ------------------------------------------------------------ */
$("formCreateGame").addEventListener("submit", async (e) => {
  e.preventDefault();
  const maxPlayers = parseInt($("inputMaxPlayers").value, 10);
  const pinRaw = $("inputAdminPin").value.trim();
  $("createError").textContent = "";

  if (!maxPlayers || maxPlayers < 3) {
    $("createError").textContent = "최소 3명 이상 입력해주세요.";
    return;
  }
  if (pinRaw && !/^\d{4}$/.test(pinRaw)) {
    $("createError").textContent = "관리자 비밀번호는 4자리 숫자로 입력해주세요 (비워두면 0000).";
    return;
  }
  const adminPin = pinRaw || "0000";

  $("btnCreateGame").disabled = true;
  try {
    let code;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateCode();
      const snap = await db.collection("games").doc(candidate).get();
      if (!snap.exists) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("코드 생성에 실패했습니다. 다시 시도해주세요.");

    await db.collection("games").doc(code).set({
      code,
      maxPlayers,
      adminPin,
      status: "lobby", // lobby | playing | ended
      phase: "lobby", // lobby | day | night | ended
      daySubphase: null,
      nightSubphase: null,
      dayNumber: 0,
      votes: {},
      voteCandidates: [],
      voteRound: 1,
      lastDayResult: null,
      nightVotes: {},
      nightCandidates: [],
      nightRound: 1,
      mafiaTargetId: null,
      doctorVotes: {},
      policeCandidates: [],
      policeChecks: {},
      decoyVotes: {},
      lastNightResult: null,
      winner: null,
      winnerTrigger: null,
      revealDeadline: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    addAdminHistory(code);
    saveSession({ code, role: "admin" });
    startAdminSession(code);
  } catch (err) {
    console.error(err);
    $("createError").textContent = "게임 생성 중 오류가 발생했습니다: " + err.message;
    $("btnCreateGame").disabled = false;
  }
});

/* ------------------------------------------------------------
   관리자 재접속 (최근 만든 게임방 목록 + 코드로 직접 재접속)
   ------------------------------------------------------------ */
const ADMIN_HISTORY_KEY = "mafiaAdminHistory";

function getAdminHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(ADMIN_HISTORY_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function addAdminHistory(code) {
  const history = getAdminHistory().filter((h) => h.code !== code);
  history.unshift({ code, createdAt: Date.now() });
  localStorage.setItem(ADMIN_HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function removeAdminHistory(code) {
  const history = getAdminHistory().filter((h) => h.code !== code);
  localStorage.setItem(ADMIN_HISTORY_KEY, JSON.stringify(history));
}

async function renderAdminHistoryList() {
  const card = $("adminHistoryCard");
  const list = $("adminHistoryList");
  const history = getAdminHistory();

  if (history.length === 0) {
    card.hidden = true;
    list.innerHTML = "";
    return;
  }

  card.hidden = false;
  list.innerHTML = history
    .map(
      (h) =>
        `<li class="admin-history-item" data-code="${h.code}">
          <button type="button" class="delete-room-btn" data-code="${h.code}" title="방 삭제">🗑️</button>
          🔑 ${h.code}<br><span class="sub-text history-status">확인 중...</span>
        </li>`
    )
    .join("");

  list.querySelectorAll(".admin-history-item").forEach((item) => {
    item.addEventListener("click", () => {
      const code = item.dataset.code;
      const pin = prompt(`${code}번 방 관리자 비밀번호(4자리)를 입력하세요.`);
      if (pin === null) return;
      attemptAdminReconnect(code, pin.trim(), null);
    });
  });

  list.querySelectorAll(".delete-room-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      if (!confirm(`${code}번 방을 완전히 삭제하시겠습니까? 되돌릴 수 없습니다.`)) return;
      try {
        await deleteGameCompletely(code);
      } catch (err) {
        console.error(err);
        alert("방 삭제 중 오류가 발생했습니다: " + err.message);
        return;
      }
      removeAdminHistory(code);
      renderAdminHistoryList();
    });
  });

  await Promise.all(
    history.map(async (h) => {
      const item = list.querySelector(`.admin-history-item[data-code="${h.code}"]`);
      if (!item) return;
      const statusEl = item.querySelector(".history-status");
      try {
        const snap = await db.collection("games").doc(h.code).get();
        if (!snap.exists) {
          statusEl.textContent = "삭제됨";
          item.style.opacity = "0.5";
          removeAdminHistory(h.code);
          return;
        }
        const g = snap.data();
        statusEl.textContent =
          g.status === "lobby"
            ? "대기중"
            : g.status === "ended"
            ? "종료됨"
            : g.status === "terminated"
            ? "강제 종료됨"
            : "진행중";
      } catch (e) {
        statusEl.textContent = "확인 실패";
      }
    })
  );
}

async function attemptAdminReconnect(code, pin, errorElId) {
  const setError = (msg) => {
    if (errorElId) $(errorElId).textContent = msg || "";
    else if (msg) alert(msg);
  };
  if (!/^\d{4}$/.test(code || "")) {
    setError("4자리 숫자 코드를 입력해주세요.");
    return;
  }
  if (!/^\d{4}$/.test(pin || "")) {
    setError("4자리 숫자 비밀번호를 입력해주세요.");
    return;
  }
  try {
    const snap = await db.collection("games").doc(code).get();
    if (!snap.exists) {
      setError("존재하지 않는 코드입니다.");
      return;
    }
    const game = snap.data();
    if (game.status === "terminated") {
      setError("관리자가 강제 종료한 게임입니다. 새 게임을 만들어주세요.");
      return;
    }
    const correctPin = game.adminPin || "0000";
    if (pin !== correctPin) {
      setError("비밀번호가 올바르지 않습니다.");
      return;
    }
    setError("");
    addAdminHistory(code);
    saveSession({ code, role: "admin" });
    startAdminSession(code);
  } catch (err) {
    console.error(err);
    setError("재접속 중 오류가 발생했습니다: " + err.message);
  }
}

$("formReconnectAdmin").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("inputReconnectCode").value.trim();
  const pin = $("inputReconnectPin").value.trim();
  attemptAdminReconnect(code, pin, "reconnectError");
});

/* ------------------------------------------------------------
   게임 참가 (플레이어)
   ------------------------------------------------------------ */
$("formJoinGame").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("inputCode").value.trim();
  const name = $("inputName").value.trim();
  $("joinError").textContent = "";

  if (!/^\d{4}$/.test(code)) {
    $("joinError").textContent = "4자리 숫자 코드를 입력해주세요.";
    return;
  }
  if (!name) {
    $("joinError").textContent = "이름을 입력해주세요.";
    return;
  }

  $("btnJoinGame").disabled = true;
  try {
    const gameRef = db.collection("games").doc(code);
    const gameSnap = await gameRef.get();
    if (!gameSnap.exists) {
      $("joinError").textContent = "존재하지 않는 코드입니다.";
      $("btnJoinGame").disabled = false;
      return;
    }
    const game = gameSnap.data();

    // 같은 코드+이름이면 예전에 참가했던 사람으로 보고 그대로 재접속시킨다
    // (게임이 이미 시작되었거나 끝났어도 재접속은 항상 허용).
    const existing = await gameRef.collection("players").where("name", "==", name).get();
    if (!existing.empty) {
      const existingDoc = existing.docs[0];
      saveSession({ code, role: "player", playerId: existingDoc.id, name });
      startPlayerSession(code, existingDoc.id);
      return;
    }

    if (game.status !== "lobby") {
      $("joinError").textContent = "이미 시작된 게임에는 새로 참가할 수 없습니다. 기존에 사용했던 이름으로 입력하면 다시 들어올 수 있어요.";
      $("btnJoinGame").disabled = false;
      return;
    }

    const playerRef = await gameRef.collection("players").add({
      name,
      role: null,
      alive: true,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    saveSession({ code, role: "player", playerId: playerRef.id, name });
    startPlayerSession(code, playerRef.id);
  } catch (err) {
    console.error(err);
    $("joinError").textContent = "참가 중 오류가 발생했습니다: " + err.message;
    $("btnJoinGame").disabled = false;
  }
});

/* ------------------------------------------------------------
   자동 재접속
   ------------------------------------------------------------ */
// startAdminSession/startPlayerSession이 쓰는 let 변수들이 아래쪽에서
// 선언되므로, 그 선언들이 모두 끝난 뒤(파일 맨 아래)에 실제로 호출한다.
function autoResume() {
  const session = loadSession();
  if (!session) {
    showScreen("screen-home");
    return;
  }
  if (session.role === "admin") {
    startAdminSession(session.code);
  } else if (session.role === "player") {
    startPlayerSession(session.code, session.playerId);
  } else {
    showScreen("screen-home");
  }
}

/* ============================================================
   관리자 세션
   ============================================================ */
let adminUnsubGame = null;
let adminUnsubPlayers = null;
let adminTickInterval = null;

// 관리자도 학생들과 함께 게임에 참여할 수 있으므로, 게임이 시작되면 화면을
// 검은 화면으로 가려둔다. "다음" 버튼을 눌러야 진행 상황이 보인다.
let adminScreenHidden = true;
let adminRerenderFn = null;

function startAdminSession(code) {
  showScreen("screen-admin");
  if (adminUnsubGame) adminUnsubGame();
  if (adminUnsubPlayers) adminUnsubPlayers();
  if (adminTickInterval) clearInterval(adminTickInterval);
  adminScreenHidden = true;

  let latestGame = null;
  let latestPlayers = [];

  const rerender = () => {
    if (!latestGame) return;
    renderAdmin(code, latestGame, latestPlayers);
    maybeAutoAdvance();
  };
  adminRerenderFn = rerender;

  // 결과 발표(reveal) 화면의 카운트다운 숫자가 매초 줄어들도록 주기적으로 다시 그린다.
  adminTickInterval = setInterval(() => {
    if (!latestGame) return;
    const inCountdown =
      (latestGame.daySubphase === "reveal" ||
        latestGame.nightSubphase === "reveal" ||
        latestGame.nightSubphase === "police_vote") &&
      latestGame.revealDeadline;
    if (inCountdown) rerender();
  }, 1000);

  // 전원이 투표를 마치면 관리자가 마감 버튼을 누르지 않아도 자동으로 다음 단계로 넘어간다.
  function maybeAutoAdvance() {
    if (adminActionBusy) return;
    const game = latestGame;
    const players = latestPlayers;
    const alivePlayers = aliveList(players);

    let action = null;

    if (game.phase === "day" && (game.daySubphase === "vote" || game.daySubphase === "revote")) {
      const votedCount = Object.keys(game.votes || {}).length;
      if (alivePlayers.length > 0 && votedCount >= alivePlayers.length) {
        action = () => closeDayVote(code, game, players);
      }
    } else if (game.phase === "day" && game.daySubphase === "reveal") {
      if (game.revealDeadline && Date.now() >= game.revealDeadline) {
        action = () => goToNight(code, players);
      }
    } else if (game.phase === "night") {
      const aliveMafia = alivePlayers.filter((p) => p.role === "mafia");
      const aliveDoctors = alivePlayers.filter((p) => p.role === "doctor");
      const alivePolice = alivePlayers.filter((p) => p.role === "police");

      // 마피아/의사/경찰이 아닌 사람도 가짜 투표 화면에서 반드시 한 번은 선택해야
      // 다음 단계로 자동으로 넘어간다. (실제 역할 수행자와 똑같이 "전원 참여"를 강제)
      const decoyVotedCount = Object.keys(game.decoyVotes || {}).length;

      if (game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") {
        const votedCount = Object.keys(game.nightVotes || {}).length;
        const aliveNonMafia = alivePlayers.filter((p) => p.role !== "mafia");
        const decoyDone = aliveNonMafia.length === 0 || decoyVotedCount >= aliveNonMafia.length;
        if (aliveMafia.length > 0 && votedCount >= aliveMafia.length && decoyDone) {
          action = () => closeMafiaVote(code, game, players);
        }
      } else if (game.nightSubphase === "mafia_done") {
        if (game.revealDeadline && Date.now() >= game.revealDeadline) {
          action = () => goToDoctorPhase(code, players);
        }
      } else if (game.nightSubphase === "doctor_vote") {
        const votedCount = Object.keys(game.doctorVotes || {}).length;
        const aliveNonDoctors = alivePlayers.filter((p) => p.role !== "doctor");
        const decoyDone = aliveNonDoctors.length === 0 || decoyVotedCount >= aliveNonDoctors.length;
        if (aliveDoctors.length > 0 && votedCount >= aliveDoctors.length && decoyDone) {
          action = () => closeDoctorVote(code, game, players);
        }
      } else if (game.nightSubphase === "police_vote") {
        const votedCount = Object.keys(game.policeChecks || {}).length;
        const aliveNonPolice = alivePlayers.filter((p) => p.role !== "police");
        const decoyDone = aliveNonPolice.length === 0 || decoyVotedCount >= aliveNonPolice.length;
        const allDone = alivePolice.length > 0 && votedCount >= alivePolice.length && decoyDone;
        if (allDone && !game.revealDeadline) {
          // 전원 조사 완료: 결과를 읽을 시간을 준 뒤 자동으로 넘어간다.
          action = () => gameRef(code).update({ revealDeadline: Date.now() + POLICE_RESULT_DELAY_MS });
        } else if (allDone && game.revealDeadline && Date.now() >= game.revealDeadline) {
          action = () => closePolicePhase(code, game, players);
        }
      } else if (game.nightSubphase === "reveal") {
        if (game.revealDeadline && Date.now() >= game.revealDeadline) {
          action = () => goToDay(code, game, players);
        }
      }
    }

    if (!action) return;
    runAdminAction(action);
  }

  adminUnsubGame = db.collection("games").doc(code).onSnapshot((snap) => {
    if (!snap.exists) {
      alert("게임을 찾을 수 없습니다. 새 게임을 만들어주세요.");
      clearSession();
      showScreen("screen-home");
      return;
    }
    const data = snap.data();
    if (data.status === "terminated") {
      alert("게임이 종료되었습니다. 처음 화면으로 돌아갑니다.");
      if (adminUnsubGame) adminUnsubGame();
      if (adminUnsubPlayers) adminUnsubPlayers();
      if (adminTickInterval) clearInterval(adminTickInterval);
      clearSession();
      showScreen("screen-home");
      return;
    }
    latestGame = data;
    setTheme(latestGame.phase);
    rerender();
  });

  adminUnsubPlayers = db
    .collection("games")
    .doc(code)
    .collection("players")
    .orderBy("joinedAt", "asc")
    .onSnapshot((snap) => {
      latestPlayers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      rerender();
    });
}

function gameRef(code) {
  return db.collection("games").doc(code);
}

// 게임방과 그 안의 참가자 정보를 Firestore에서 완전히 삭제한다.
async function deleteGameCompletely(code) {
  const playersSnap = await gameRef(code).collection("players").get();
  const batch = db.batch();
  playersSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(gameRef(code));
  await batch.commit();
}

function renderAdmin(code, game, players) {
  const el = $("adminContent");
  const screenSection = $("screen-admin");
  if (screenSection) {
    screenSection.classList.toggle("blackout-active", game.status === "playing" && adminScreenHidden);
  }
  const hideBtn = $("btnHideAdminScreen");
  if (hideBtn) {
    hideBtn.hidden = !(game.status === "playing" && !adminScreenHidden);
    hideBtn.onclick = () => {
      adminScreenHidden = true;
      if (adminRerenderFn) adminRerenderFn();
    };
  }

  if (game.status === "playing" && adminScreenHidden) {
    el.innerHTML = `
      <div class="admin-blackout">
        <button class="big-btn" id="btnRevealAdminScreen">▶️ 게임 진행 상황을 보려면 다음 버튼을 누르세요</button>
      </div>
    `;
    $("btnRevealAdminScreen").addEventListener("click", () => {
      adminScreenHidden = false;
      if (adminRerenderFn) adminRerenderFn();
    });
    return;
  }

  if (game.status === "lobby") {
    el.innerHTML = `
      <div class="title-row">
        <h1>관리자 대기실</h1>
        <p>참가자들에게 아래 코드를 알려주세요</p>
      </div>
      <div class="card">
        <div class="code-display">${game.code}</div>
        <p class="center-text sub-text">목표 인원: ${game.maxPlayers}명 · 현재 참가: ${players.length}명</p>
        <ul class="lobby-list" id="lobbyPlayerList"></ul>
        <button class="big-btn" id="btnStartGame" ${players.length < 3 ? "disabled" : ""}>
          ${players.length < 3 ? "최소 3명 필요" : "🎬 게임 시작하기"}
        </button>
      </div>
    `;
    const list = $("lobbyPlayerList");
    list.innerHTML = renderLobbyListItems(
      players,
      players.map((p) => p.id)
    );
    wireLobbyEditButtons(list, code, players);
    $("btnStartGame").addEventListener("click", () => startGame(code, players));
    return;
  }

  if (game.status === "ended") {
    // 게임이 완전히 끝난 화면에서는 밤사이/낮에 누가 탈락했는지는 보여주지 않고,
    // 승패 결과만 맨 위에 보여준다. 하단의 목록 형태 역할 보기 대신, 게임 중
    // 낮/밤에 쓰던 것과 같은 사각 박스 명단을 오른쪽 칸에 (절반 크기로) 보여준다.
    el.innerHTML = `
      ${renderCodeChip(game.code)}
      <div class="admin-split admin-split-ended">
        <div class="admin-split-left">
          ${renderWinnerModalInline(game)}
          <div class="card center-text">
            <button class="big-btn secondary" id="btnEndToHome">🏠 홈으로</button>
            <button class="big-btn" id="btnEndToNewGame">🆕 새 게임 만들기</button>
          </div>
        </div>
        <div class="admin-split-right">
          ${renderPlayerGrid(players, { mode: "admin-view", compact: true })}
        </div>
      </div>
    `;

    // 게임이 완전히 끝났으므로 홈으로 가든 새 게임을 만들든 이 방은 완전히 삭제한다.
    async function endAndDeleteRoom() {
      if (!confirm("이 게임방을 완전히 삭제합니다. 계속할까요? (되돌릴 수 없습니다)")) return false;
      // 삭제 후에도 리스너가 남아있으면 "게임을 찾을 수 없습니다" 알림이 중복으로 뜨므로 먼저 정리한다.
      if (adminUnsubGame) adminUnsubGame();
      if (adminUnsubPlayers) adminUnsubPlayers();
      if (adminTickInterval) clearInterval(adminTickInterval);
      try {
        await deleteGameCompletely(code);
      } catch (err) {
        console.error(err);
        alert("방 삭제 중 오류가 발생했습니다: " + err.message);
        return false;
      }
      removeAdminHistory(code);
      clearSession();
      return true;
    }

    $("btnEndToHome").addEventListener("click", async () => {
      if (await endAndDeleteRoom()) showScreen("screen-home");
    });
    $("btnEndToNewGame").addEventListener("click", async () => {
      if (await endAndDeleteRoom()) enterCreateScreen();
    });
    return;
  }

  // playing
  // 카운트다운은 아래쪽 "진행 조작" 패널에 버튼과 함께 표시되므로, 여기서는 중복으로
  // 뜨지 않도록 includeCountdown: false로 렌더링한다.
  const liveRevealBox =
    game.phase === "day" && game.daySubphase === "reveal"
      ? renderDayRevealBox(game, players, false)
      : game.phase === "night" && game.nightSubphase === "reveal"
      ? renderNightRevealBox(game, players, false)
      : "";
  // 이름+역할은 위쪽 참가자 박스(renderPlayerGrid의 admin-view 모드)에 이미 뜨므로,
  // 여기서는 목록 형태로 중복해서 보여주지 않는다.
  // "진행 조작" 패널을 오른쪽 칸으로 빼서, 태블릿 화면에서 스크롤 없이 한눈에
  // 보이도록 좌/우 두 칸으로 나눈다 (좁은 화면에서는 CSS가 자동으로 위아래로 쌓는다).
  el.innerHTML = `
    ${renderCodeChip(game.code)}
    ${renderPhaseBanner(game)}
    <div class="admin-split">
      <div class="admin-split-left">
        ${renderCountsRow(game, players)}
        ${liveRevealBox}
        ${renderPlayerGrid(players, { mode: "admin-view", compact: true })}
      </div>
      <div class="admin-split-right">
        ${renderNightStatusPanel(game, players)}
        ${renderAdminControlPanel(code, game, players)}
      </div>
    </div>
  `;
  wireAdminControlPanel(code, game, players);
}

async function startGame(code, players) {
  if (players.length < 3) return;
  const { mafiaCount, doctorCount, policeCount, citizenCount } = computeRoleCounts(players.length);
  const roles = [
    ...Array(mafiaCount).fill("mafia"),
    ...Array(doctorCount).fill("doctor"),
    ...Array(policeCount).fill("police"),
    ...Array(citizenCount).fill("citizen"),
  ];
  const shuffledRoles = shuffle(roles);

  const batch = db.batch();
  players.forEach((p, i) => {
    const ref = gameRef(code).collection("players").doc(p.id);
    batch.update(ref, { role: shuffledRoles[i], alive: true });
  });
  batch.update(gameRef(code), {
    status: "playing",
    phase: "day",
    daySubphase: "vote",
    dayNumber: 1,
    votes: {},
    voteCandidates: players.map((p) => p.id),
    voteRound: 1,
    winner: null,
    policeCandidates: [],
    policeChecks: {},
  });
  await batch.commit();
}

// 게임이 시작된 뒤에도 화면 상단에서 참가 코드를 계속 확인할 수 있도록 표시한다.
function renderCodeChip(code) {
  return `<div class="center-text"><span class="code-chip">🔑 코드 ${code}</span></div>`;
}

// 가짜 경찰 조사 결과에 쓸 문구. 실제 결과처럼 보이도록 전부 긍정적인 표현만 사용한다.
const DECOY_POLICE_RESULTS = [
  "정말 착한 사람입니다.",
  "친구를 잘 도와주는 사람입니다.",
  "믿음직스러운 사람입니다.",
  "웃음이 많은 사람입니다.",
  "성실하고 부지런한 사람입니다.",
  "다정하고 친절한 사람입니다.",
  "용감하고 씩씩한 사람입니다.",
  "똑똑하고 지혜로운 사람입니다.",
  "인기가 많은 사람입니다.",
  "긍정 에너지가 넘치는 사람입니다.",
  "배려심이 많은 사람입니다.",
  "리더십이 뛰어난 사람입니다.",
];
function randomDecoyPoliceResult() {
  return DECOY_POLICE_RESULTS[Math.floor(Math.random() * DECOY_POLICE_RESULTS.length)];
}

// 밤에 실제로 행동하는 역할(마피아/의사/경찰)이 아닌 사람에게도 똑같이 생긴 선택 화면을
// 보여준다. 선택 결과 자체는 게임 진행에 영향을 주지 않지만, 옆에서 봤을 때 누가 진짜로
// 밤 행동을 하는지 구분할 수 없도록 반드시 한 번은 선택해야 다음 단계로 넘어간다.
// locked가 true면(의사/경찰 차례) 한 번 선택한 뒤에는 바꿀 수 없다는 안내를 보여준다.
function renderDecoyVote(players, myId, candidates, promptText, selectedId, locked) {
  return `
    <p class="center-text sub-text">${promptText}</p>
    <p class="center-text sub-text">${
      locked
        ? "(선택해도 게임 결과에는 전혀 반영되지 않아요. 한 번 선택하면 바꿀 수 없으니 신중하게 골라주세요!)"
        : "(선택해도 게임 결과에는 전혀 반영되지 않아요. 그래도 다음으로 넘어가려면 반드시 한 명을 선택해야 해요!)"
    }</p>
    ${renderPlayerGrid(players, {
      mode: "decoy-vote",
      myId,
      selectedId,
      candidates,
    })}
  `;
}

/* ------------------------------------------------------------
   낮/밤 공통 표시 요소
   ------------------------------------------------------------ */
function renderPhaseBanner(game) {
  if (game.phase === "day") {
    const labels = { vote: "투표 시간", revote: "재투표 시간", reveal: "결과 발표" };
    // 첫 번째 낮에는 아직 서로 이름을 모르므로 자기소개 안내를 덧붙인다.
    const discussionHint =
      game.dayNumber === 1
        ? "태블릿이 보이지 않게 덮어두고 한 장소에 모여 돌아가며 자기소개를 하고 이야기를 나눠보세요."
        : "태블릿이 보이지 않게 덮어두고 한 장소에 모여 이야기를 나눠보세요.";
    return `<div class="phase-banner">☀️ 낮 ${game.dayNumber}일차 - ${labels[game.daySubphase] || ""}
      <span class="day-num">마피아로 의심되는 사람을 찾아 이야기해보세요</span>
      <span class="day-num">${discussionHint}</span></div>`;
  }
  if (game.phase === "night") {
    const labels = {
      mafia_vote: "마피아가 대상을 고르는 중",
      mafia_revote: "마피아 재투표 중",
      mafia_done: "의사에게 넘어가는 중",
      doctor_vote: "의사가 살릴 사람을 고르는 중",
      police_vote: "경찰이 조사하는 중",
      reveal: "결과 발표",
    };
    return `<div class="phase-banner">🌙 밤 ${game.dayNumber}일차 - ${labels[game.nightSubphase] || ""}
      <span class="day-num">눈을 감고 조용히 기다려주세요</span></div>`;
  }
  return "";
}

function renderCountsRow(game, players) {
  const total = players.length;
  const aliveMafia = countByRole(players, "mafia");
  const aliveCitizen = countByRole(players, "citizen");
  const aliveDoctor = countByRole(players, "doctor");
  const alivePolice = countByRole(players, "police");
  return `
    <div class="counts-row">
      <div class="count-pill"><span class="num">${total}</span><span class="label">총 인원</span></div>
      <div class="count-pill"><span class="num">${aliveMafia}</span><span class="label">생존 마피아</span></div>
      <div class="count-pill"><span class="num">${aliveCitizen}</span><span class="label">생존 시민</span></div>
      <div class="count-pill"><span class="num">${aliveDoctor}</span><span class="label">생존 의사</span></div>
      <div class="count-pill"><span class="num">${alivePolice}</span><span class="label">생존 경찰</span></div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// 대기실 명단을 렌더링한다. editableIds에 포함된 참가자 옆에는 이름 수정(✏️) 버튼을 붙인다.
function renderLobbyListItems(players, editableIds, selfId) {
  if (players.length === 0) {
    return `<li class="sub-text lobby-empty">아직 참가자가 없습니다...</li>`;
  }
  return players
    .map((p) => {
      const canEdit = editableIds.includes(p.id);
      const editBtn = canEdit
        ? `<button type="button" class="edit-name-btn" data-player-id="${p.id}">✏️</button>`
        : "";
      const selfTag = p.id === selfId ? " (나)" : "";
      return `<li>🙋 ${escapeHtml(p.name)}${selfTag}${editBtn}</li>`;
    })
    .join("");
}

function wireLobbyEditButtons(container, code, players) {
  container.querySelectorAll(".edit-name-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const player = players.find((p) => p.id === btn.dataset.playerId);
      if (!player) return;
      renamePlayer(code, player.id, player.name);
    });
  });
}

async function renamePlayer(code, playerId, currentName) {
  const input = prompt("새 이름을 입력하세요.", currentName);
  if (input === null) return;
  const newName = input.trim();
  if (!newName) {
    alert("이름을 입력해주세요.");
    return;
  }
  if (newName === currentName) return;
  try {
    const existing = await gameRef(code).collection("players").where("name", "==", newName).get();
    if (!existing.empty) {
      alert("이미 사용 중인 이름입니다. 다른 이름을 입력해주세요.");
      return;
    }
    await gameRef(code).collection("players").doc(playerId).update({ name: newName });
  } catch (err) {
    console.error(err);
    alert("이름 변경 중 오류가 발생했습니다: " + err.message);
  }
}

// mode: 'admin-view' | 'day-vote' | 'night-mafia-vote' | 'night-doctor-vote' | 'night-police-vote' | 'decoy-vote' | 'plain'
function renderPlayerGrid(players, opts) {
  const { mode, myId, selectedId, candidates, compact } = opts;
  const showRoleReveal = mode === "admin-view" || mode === "plain-with-reveal";

  return `<div class="grid${compact ? " compact" : ""}">
    ${players
      .map((p) => {
        const isDead = !p.alive;
        const isCandidate = candidates ? candidates.includes(p.id) : true;
        const clickable =
          (mode === "day-vote" ||
            mode === "night-mafia-vote" ||
            mode === "night-doctor-vote" ||
            mode === "night-police-vote" ||
            mode === "decoy-vote") &&
          !isDead &&
          isCandidate &&
          p.id !== myId;
        const selected = selectedId === p.id;
        let revealTag = "";
        let cardClass = "player-card";
        if (isDead) cardClass += " dead";
        if (!clickable) cardClass += " not-selectable";
        if (selected) cardClass += " selected";

        if (isDead && p.role) {
          cardClass += ` revealed-${p.role}`;
          revealTag = `<span class="role-tag ${p.role}">${roleLabel(p.role)}</span>`;
        } else if (showRoleReveal && p.role) {
          revealTag = `<span class="role-tag ${p.role}">${roleLabel(p.role)}</span>`;
        }

        return `<div class="${cardClass}" data-player-id="${p.id}">
          <span class="avatar">${isDead ? "💀" : "🙂"}</span>
          <div class="pname">${escapeHtml(p.name)}${p.id === myId ? " (나)" : ""}</div>
          ${revealTag}
        </div>`;
      })
      .join("")}
  </div>`;
}

/* ------------------------------------------------------------
   관리자 진행 컨트롤 패널
   ------------------------------------------------------------ */
function tally(voteMap, candidates) {
  const counts = {};
  candidates.forEach((c) => (counts[c] = 0));
  Object.values(voteMap || {}).forEach((target) => {
    if (counts[target] !== undefined) counts[target]++;
  });
  return counts;
}

function topVoted(counts) {
  let max = 0;
  Object.values(counts).forEach((v) => { if (v > max) max = v; });
  if (max === 0) return [];
  return Object.keys(counts).filter((k) => counts[k] === max);
}

function renderTallyList(counts, players) {
  const nameOf = (id) => players.find((p) => p.id === id)?.name || "?";
  return `<ul class="tally-list">
    ${Object.entries(counts)
      .map(([id, n]) => `<li><span>${escapeHtml(nameOf(id))}</span><span>${n}표</span></li>`)
      .join("")}
  </ul>`;
}

// 관리자 패널에 아직 투표/선택하지 않은 사람 명단을 ", 미투표자: A, B" 형태로 덧붙인다.
function renderNonVoterList(eligiblePlayers, responseMap, label) {
  const respondedIds = new Set(Object.keys(responseMap || {}));
  const remaining = eligiblePlayers.filter((p) => !respondedIds.has(p.id));
  if (remaining.length === 0) return "";
  return `, ${label}: ${remaining.map((p) => escapeHtml(p.name)).join(", ")}`;
}

// 모든 투표/선택 현황을 "이름표: X/Y명, 미참여자: A, B" 형태로 통일해서 보여준다.
function renderVoteStatusLine(label, eligiblePlayers, responseMap, nonVoterLabel) {
  const votedCount = Object.keys(responseMap || {}).length;
  return `<p class="sub-text">${label}: ${votedCount}/${eligiblePlayers.length}명${renderNonVoterList(
    eligiblePlayers,
    responseMap,
    nonVoterLabel
  )}</p>`;
}

// 밤에 실제 역할을 수행하지 않는 사람들의 "가짜 투표" 참여 현황을 관리자에게 보여준다.
// 이 사람들도 전원 선택해야 다음 단계로 자동 진행된다.
function renderDecoyStatusLine(alivePlayers, excludeRole, decoyVotes) {
  const eligible = alivePlayers.filter((p) => p.role !== excludeRole);
  if (eligible.length === 0) return "";
  return renderVoteStatusLine("가짜 투표(다른 참가자) 참여 현황", eligible, decoyVotes, "미참여자");
}

// 이름 → 표(투표/선택) 수를 집계해 "OOO(2표), XXX" 형태의 요약 문구로 보여준다.
// 밤 동안 마피아/의사/경찰이 각자 누구를 선택했는지 관리자가 계속 확인할 수 있게 해준다.
function renderChosenSummary(voteMap, players) {
  const counts = {};
  Object.values(voteMap || {}).forEach((targetId) => {
    if (!targetId) return;
    counts[targetId] = (counts[targetId] || 0) + 1;
  });
  const entries = Object.entries(counts);
  if (entries.length === 0) return "아직 선택 없음";
  return entries
    .map(([id, n]) => {
      const name = escapeHtml(players.find((p) => p.id === id)?.name || "?");
      return n > 1 ? `${name}(${n}표)` : name;
    })
    .join(", ");
}

// 경찰별 조사 결과를 "OOO(조사성공:마피아), XXX(조사 실패)" 형태로 보여준다.
// 경찰이 여러 명이면 각자 다른 사람을 조사할 수 있으므로, 이름만 모아 보여주는
// renderChosenSummary 대신 조사자별 결과를 하나씩 보여준다.
function renderPoliceCheckSummary(policeChecks, players) {
  const entries = Object.entries(policeChecks || {});
  if (entries.length === 0) return "아직 선택 없음";
  return entries
    .map(([, check]) => {
      const targetName = escapeHtml(players.find((p) => p.id === check.targetId)?.name || "?");
      const resultText = check.success ? `조사성공:${check.isMafia ? "마피아" : "마피아 아님"}` : "조사 실패";
      return `${targetName}(${resultText})`;
    })
    .join(", ");
}

// 밤 동안 계속 떠 있는 진행 상황 패널. 마피아/의사/경찰이 각자 누구를 선택했는지
// 실시간으로 보여주고, 낮이 되면(game.phase !== "night") 사라진다.
function renderNightStatusPanel(game, players) {
  if (game.phase !== "night") return "";

  return `
    <div class="panel night-status-panel">
      <h3 style="margin-top:0;color:#7a54d4;">🌙 밤 진행 상황 (실시간)</h3>
      <p class="sub-text">🔪 마피아가 선택한 사람: <strong>${renderChosenSummary(game.nightVotes, players)}</strong></p>
      <p class="sub-text">💉 의사가 선택한 사람: <strong>${renderChosenSummary(game.doctorVotes, players)}</strong></p>
      <p class="sub-text">🔍 경찰이 조사한 사람: <strong>${renderPoliceCheckSummary(game.policeChecks, players)}</strong></p>
    </div>
  `;
}

function renderAdminControlPanel(code, game, players) {
  const alivePlayers = aliveList(players);

  if (game.phase === "day") {
    if (game.daySubphase === "vote" || game.daySubphase === "revote") {
      const counts = tally(game.votes, game.voteCandidates);
      return `<div class="admin-panel">
        <h3>진행 조작 ${game.voteRound > 1 ? `(재투표 ${game.voteRound}회차)` : ""}</h3>
        ${renderVoteStatusLine("투표 현황", alivePlayers, game.votes, "미투표자")}
        ${renderTallyList(counts, players)}
        <button class="big-btn" id="btnCloseVote">✅ 투표 마감하고 결과 확인</button>
      </div>`;
    }
    if (game.daySubphase === "reveal") {
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        ${renderCountdownText(game.revealDeadline, "🌙 밤이 됩니다")}
        <button class="big-btn" id="btnGoNight">🌙 지금 바로 밤으로 진행하기</button>
      </div>`;
    }
  }

  if (game.phase === "night") {
    const aliveMafia = alivePlayers.filter((p) => p.role === "mafia");
    const aliveDoctors = alivePlayers.filter((p) => p.role === "doctor");
    const alivePolice = alivePlayers.filter((p) => p.role === "police");

    if (game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") {
      const counts = tally(game.nightVotes, game.nightCandidates);
      return `<div class="admin-panel">
        <h3>진행 조작 ${game.nightRound > 1 ? `(재투표 ${game.nightRound}회차)` : ""}</h3>
        ${renderVoteStatusLine("마피아 투표 현황", aliveMafia, game.nightVotes, "미투표자")}
        ${renderTallyList(counts, players)}
        ${renderDecoyStatusLine(alivePlayers, "mafia", game.decoyVotes)}
        <button class="big-btn" id="btnCloseMafiaVote">✅ 마피아 투표 마감</button>
      </div>`;
    }
    if (game.nightSubphase === "mafia_done") {
      const nextIsDoctor = aliveDoctors.length > 0;
      const nextLabel = nextIsDoctor ? "💉 의사에게 넘어갑니다" : "🔍 경찰에게 넘어갑니다";
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        ${renderCountdownText(game.revealDeadline, nextLabel)}
        <button class="big-btn" id="btnGoDoctor">${nextIsDoctor ? "💉" : "🔍"} 지금 바로 넘기기</button>
      </div>`;
    }
    if (game.nightSubphase === "doctor_vote") {
      const doctorCounts = tally(game.doctorVotes, alivePlayers.map((p) => p.id));
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        ${renderVoteStatusLine("의사 선택 현황", aliveDoctors, game.doctorVotes, "미선택자")}
        ${renderTallyList(doctorCounts, players)}
        ${renderDecoyStatusLine(alivePlayers, "doctor", game.decoyVotes)}
        <button class="big-btn" id="btnCloseDoctorVote">✅ 의사 선택 마감하고 결과 확인</button>
      </div>`;
    }
    if (game.nightSubphase === "police_vote") {
      const policeTargetMap = {};
      Object.entries(game.policeChecks || {}).forEach(([voterId, check]) => {
        policeTargetMap[voterId] = check.targetId;
      });
      const policeCounts = tally(policeTargetMap, game.policeCandidates || []);
      const votedCount = Object.keys(game.policeChecks || {}).length;
      const allDone = alivePolice.length > 0 && votedCount >= alivePolice.length;
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        ${renderVoteStatusLine("경찰 조사 현황", alivePolice, game.policeChecks, "미선택자")}
        ${renderTallyList(policeCounts, players)}
        ${renderDecoyStatusLine(alivePlayers, "police", game.decoyVotes)}
        ${allDone ? renderCountdownText(game.revealDeadline, "☀️ 결과 확인으로 넘어갑니다") : ""}
        <button class="big-btn" id="btnClosePoliceVote">✅ ${allDone ? "지금 바로 결과 확인" : "경찰 조사 마감하고 결과 확인"}</button>
      </div>`;
    }
    if (game.nightSubphase === "reveal") {
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        ${renderCountdownText(game.revealDeadline, "☀️ 낮이 됩니다")}
        <button class="big-btn" id="btnGoDay">☀️ 지금 바로 낮으로 진행하기</button>
      </div>`;
    }
  }

  return "";
}

function wireAdminControlPanel(code, game, players) {
  const btnCloseVote = $("btnCloseVote");
  if (btnCloseVote) {
    btnCloseVote.addEventListener("click", () => runAdminAction(() => closeDayVote(code, game, players)));
  }

  const btnGoNight = $("btnGoNight");
  if (btnGoNight) {
    btnGoNight.addEventListener("click", () => runAdminAction(() => goToNight(code, players)));
  }

  const btnCloseMafiaVote = $("btnCloseMafiaVote");
  if (btnCloseMafiaVote) {
    btnCloseMafiaVote.addEventListener("click", () => runAdminAction(() => closeMafiaVote(code, game, players)));
  }

  const btnGoDoctor = $("btnGoDoctor");
  if (btnGoDoctor) {
    btnGoDoctor.addEventListener("click", () => runAdminAction(() => goToDoctorPhase(code, players)));
  }

  const btnCloseDoctorVote = $("btnCloseDoctorVote");
  if (btnCloseDoctorVote) {
    btnCloseDoctorVote.addEventListener("click", () => runAdminAction(() => closeDoctorVote(code, game, players)));
  }

  const btnClosePoliceVote = $("btnClosePoliceVote");
  if (btnClosePoliceVote) {
    btnClosePoliceVote.addEventListener("click", () => runAdminAction(() => closePolicePhase(code, game, players)));
  }

  const btnGoDay = $("btnGoDay");
  if (btnGoDay) {
    btnGoDay.addEventListener("click", () => runAdminAction(() => goToDay(code, game, players)));
  }
}

async function goToNight(code, players) {
  const aliveNonMafia = aliveList(players).filter((p) => p.role !== "mafia");
  await gameRef(code).update({
    phase: "night",
    nightSubphase: "mafia_vote",
    nightVotes: {},
    nightCandidates: aliveNonMafia.map((p) => p.id),
    nightRound: 1,
    mafiaTargetId: null,
    doctorVotes: {},
    policeCandidates: [],
    policeChecks: {},
    decoyVotes: {},
    lastNightResult: null,
    revealDeadline: null,
  });
}

async function goToDoctorPhase(code, players) {
  const aliveDoctors = aliveList(players).filter((p) => p.role === "doctor");
  if (aliveDoctors.length > 0) {
    await gameRef(code).update({
      nightSubphase: "doctor_vote",
      doctorVotes: {},
      decoyVotes: {},
      revealDeadline: null,
    });
  } else {
    // 의사가 없으면 곧장 경찰 조사로 넘어간다 (여기 도달했다면 경찰이 살아있다는 뜻).
    await goToPolicePhase(code, players);
  }
}

async function goToPolicePhase(code, players) {
  const aliveTargets = aliveList(players).map((p) => p.id);
  await gameRef(code).update({
    nightSubphase: "police_vote",
    policeCandidates: aliveTargets,
    policeChecks: {},
    decoyVotes: {},
    revealDeadline: null,
  });
}

async function goToDay(code, game, players) {
  const alive = aliveList(players);
  await gameRef(code).update({
    phase: "day",
    daySubphase: "vote",
    dayNumber: (game.dayNumber || 1) + 1,
    votes: {},
    voteCandidates: alive.map((p) => p.id),
    voteRound: 1,
    lastDayResult: null,
    revealDeadline: null,
  });
}

async function closeDayVote(code, game, players) {
  const counts = tally(game.votes, game.voteCandidates);
  const winners = topVoted(counts);

  if (winners.length === 0) {
    // 아무도 투표하지 않음 -> 탈락자 없음
    await applyDayResult(code, { eliminatedId: null, noVotes: true });
    return;
  }

  if (winners.length > 1) {
    // 동률인 사람들만 데리고 최다 득표자가 1명이 될 때까지 계속 재투표한다.
    await gameRef(code).update({
      daySubphase: "revote",
      voteCandidates: winners,
      votes: {},
      voteRound: (game.voteRound || 1) + 1,
    });
    return;
  }

  await applyDayResult(code, { eliminatedId: winners[0] });
}

async function applyDayResult(code, { eliminatedId, noVotes }) {
  const playersSnap = await gameRef(code).collection("players").get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let eliminatedName = null;
  let eliminatedRole = null;

  if (eliminatedId) {
    await gameRef(code).collection("players").doc(eliminatedId).update({ alive: false });
    const p = players.find((pp) => pp.id === eliminatedId);
    eliminatedName = p?.name || "";
    eliminatedRole = p?.role || "";
  }

  const updatedPlayers = players.map((p) => (p.id === eliminatedId ? { ...p, alive: false } : p));
  const winner = checkWinner(updatedPlayers);

  await gameRef(code).update({
    daySubphase: "reveal",
    lastDayResult: { eliminatedId: eliminatedId || null, eliminatedName, eliminatedRole, noVotes: !!noVotes },
    status: winner ? "ended" : "playing",
    phase: winner ? "ended" : "day",
    winner: winner || null,
    winnerTrigger: winner ? "day" : null,
    revealDeadline: winner ? null : Date.now() + REVEAL_COUNTDOWN_MS,
  });
}

async function closeMafiaVote(code, game, players) {
  const counts = tally(game.nightVotes, game.nightCandidates);
  const winners = topVoted(counts);

  if (winners.length === 0) {
    await resolveNight(code, { mafiaTargetId: null });
    return;
  }

  if (winners.length > 1) {
    // 동률인 대상들만 데리고 최다 득표자가 1명이 될 때까지 계속 재투표한다.
    // 가짜 투표는 마피아 차례 전체에서 한 번만 하면 되므로(재투표해도 다시 요구하지 않음)
    // decoyVotes는 여기서 초기화하지 않는다.
    await gameRef(code).update({
      nightSubphase: "mafia_revote",
      nightCandidates: winners,
      nightVotes: {},
      nightRound: (game.nightRound || 1) + 1,
    });
    return;
  }

  const targetId = winners[0];
  const aliveDoctors = aliveList(players).filter((p) => p.role === "doctor");
  const alivePolice = aliveList(players).filter((p) => p.role === "police");
  if (aliveDoctors.length === 0 && alivePolice.length === 0) {
    await resolveNight(code, { mafiaTargetId: targetId });
  } else {
    // 의사(또는 경찰) 선택으로 넘어가기 전 잠깐 카운트다운을 보여준다.
    await gameRef(code).update({
      mafiaTargetId: targetId,
      nightSubphase: "mafia_done",
      revealDeadline: Date.now() + REVEAL_COUNTDOWN_MS,
    });
  }
}

async function closeDoctorVote(code, game, players) {
  const alivePolice = aliveList(players).filter((p) => p.role === "police");
  if (alivePolice.length === 0) {
    await resolveNight(code, { mafiaTargetId: game.mafiaTargetId, doctorVotes: game.doctorVotes });
  } else {
    // 대기 없이 곧바로 경찰 조사로 넘어간다.
    await goToPolicePhase(code, players);
  }
}

async function closePolicePhase(code, game, players) {
  await resolveNight(code, { mafiaTargetId: game.mafiaTargetId, doctorVotes: game.doctorVotes });
}

async function resolveNight(code, { mafiaTargetId, doctorVotes }) {
  const playersSnap = await gameRef(code).collection("players").get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let saved = false;
  let doctorFailed = false;
  let killedName = null;
  let killedRole = null;

  if (mafiaTargetId) {
    const targetPlayer = players.find((pp) => pp.id === mafiaTargetId);
    const savedSet = new Set(Object.values(doctorVotes || {}));
    const doctorTriedToSave = savedSet.has(mafiaTargetId);
    // 의사는 경찰을 살릴 수 없다: 경찰을 선택했더라도 실제로는 구해지지 않는다.
    const isPolice = targetPlayer && targetPlayer.role === "police";
    saved = doctorTriedToSave && !isPolice;
    doctorFailed = doctorTriedToSave && isPolice;
    if (!saved) {
      await gameRef(code).collection("players").doc(mafiaTargetId).update({ alive: false });
      killedName = targetPlayer?.name || "";
      killedRole = targetPlayer?.role || "";
    }
  }

  const updatedPlayers = players.map((p) => (p.id === mafiaTargetId && !saved ? { ...p, alive: false } : p));
  const winner = checkWinner(updatedPlayers);

  await gameRef(code).update({
    nightSubphase: "reveal",
    lastNightResult: {
      targetId: mafiaTargetId || null,
      targetName: killedName,
      targetRole: killedRole,
      saved,
      doctorFailed,
      nobody: !mafiaTargetId,
    },
    status: winner ? "ended" : "playing",
    phase: winner ? "ended" : "night",
    winner: winner || null,
    winnerTrigger: winner ? "night" : null,
    revealDeadline: winner ? null : Date.now() + REVEAL_COUNTDOWN_MS,
  });
}

function checkWinner(players) {
  const aliveMafia = players.filter((p) => p.alive && p.role === "mafia").length;
  const aliveOthers = players.filter((p) => p.alive && p.role !== "mafia").length;
  if (aliveMafia === 0) return "citizen";
  if (aliveOthers <= aliveMafia) return "mafia";
  return null;
}

function renderWinnerModalInline(game) {
  if (!game.winner) return "";
  const isCitizen = game.winner === "citizen";
  return `
    <div class="card center-text">
      <span style="font-size:3rem;display:block;">${isCitizen ? "🎉" : "🔪"}</span>
      <h2 class="${isCitizen ? "winner-citizen" : "winner-mafia"}">${isCitizen ? "시민 승리!" : "마피아 승리!"}</h2>
      <p class="sub-text">${isCitizen ? "마피아를 모두 찾아냈습니다." : "마피아의 수가 시민 수 이상이 되었습니다."}</p>
    </div>
  `;
}

/* ============================================================
   플레이어 세션
   ============================================================ */
let playerUnsubGame = null;
let playerUnsubPlayers = null;
let playerTickInterval = null;

function startPlayerSession(code, playerId) {
  showScreen("screen-player");
  if (playerUnsubGame) playerUnsubGame();
  if (playerUnsubPlayers) playerUnsubPlayers();
  if (playerTickInterval) clearInterval(playerTickInterval);

  let latestGame = null;
  let latestPlayers = [];

  const rerender = () => {
    if (!latestGame) return;
    const me = latestPlayers.find((p) => p.id === playerId);
    if (!me) {
      // 강퇴/데이터 없음 등
      renderPlayerWaiting("게임 정보를 찾을 수 없습니다.");
      return;
    }
    renderPlayer(code, playerId, latestGame, latestPlayers, me);
  };

  // 결과 발표(reveal) 화면의 카운트다운 숫자가 매초 줄어들도록 주기적으로 다시 그린다.
  playerTickInterval = setInterval(() => {
    if (!latestGame) return;
    const inCountdown =
      (latestGame.daySubphase === "reveal" ||
        latestGame.nightSubphase === "reveal" ||
        latestGame.nightSubphase === "police_vote") &&
      latestGame.revealDeadline;
    if (inCountdown) rerender();
  }, 1000);

  playerUnsubGame = db.collection("games").doc(code).onSnapshot((snap) => {
    if (!snap.exists) {
      alert("게임이 삭제되었거나 찾을 수 없습니다.");
      clearSession();
      showScreen("screen-home");
      return;
    }
    const data = snap.data();
    if (data.status === "terminated") {
      alert("관리자가 게임을 종료했습니다. 처음 화면으로 돌아갑니다.");
      if (playerUnsubGame) playerUnsubGame();
      if (playerUnsubPlayers) playerUnsubPlayers();
      if (playerTickInterval) clearInterval(playerTickInterval);
      clearSession();
      showScreen("screen-home");
      return;
    }
    latestGame = data;
    setTheme(latestGame.phase);
    rerender();
  });

  playerUnsubPlayers = db
    .collection("games")
    .doc(code)
    .collection("players")
    .orderBy("joinedAt", "asc")
    .onSnapshot((snap) => {
      latestPlayers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      rerender();
    });
}

function renderPlayerWaiting(msg) {
  $("playerContent").innerHTML = `<div class="waiting-box"><span class="icon">⏳</span><p>${msg}</p></div>`;
}

function renderPlayer(code, playerId, game, players, me) {
  const el = $("playerContent");
  document.body.classList.toggle("player-dead", !me.alive);

  if (game.status === "lobby") {
    el.innerHTML = `
      <div class="title-row">
        <h1>대기실</h1>
        <p>관리자가 게임을 시작할 때까지 기다려주세요</p>
      </div>
      <div class="card">
        <p class="center-text">참가 코드: <strong>${game.code}</strong></p>
        <p class="center-text sub-text">${players.length}명 참가 중</p>
        <ul class="lobby-list" id="playerLobbyList"></ul>
      </div>
    `;
    const list = $("playerLobbyList");
    list.innerHTML = renderLobbyListItems(players, [playerId], playerId);
    wireLobbyEditButtons(list, code, players);
    return;
  }

  if (game.status === "ended") {
    const isCitizen = game.winner === "citizen";
    const revealBox = game.winnerTrigger === "night" ? renderNightRevealBox(game) : renderDayRevealBox(game);
    el.innerHTML = `
      ${renderCodeChip(game.code)}
      ${revealBox}
      <div class="card center-text">
        <span style="font-size:3rem;display:block;">${isCitizen ? "🎉" : "🔪"}</span>
        <h2 class="${isCitizen ? "winner-citizen" : "winner-mafia"}">${isCitizen ? "시민 승리!" : "마피아 승리!"}</h2>
        <p class="sub-text">당신의 역할은 <strong>${roleLabel(me.role)}</strong> 였습니다.</p>
        <button class="big-btn" id="btnJoinNewGame">🙋 새 게임 참여하기</button>
      </div>
      ${renderFinalRoster(players)}
    `;
    $("btnJoinNewGame").addEventListener("click", () => {
      if (playerUnsubGame) playerUnsubGame();
      if (playerUnsubPlayers) playerUnsubPlayers();
      if (playerTickInterval) clearInterval(playerTickInterval);
      clearSession();
      enterJoinScreen();
    });
    return;
  }

  // playing
  const myRoleBox = `
    <div class="role-box role-${me.role}">
      ${roleEmoji(me.role)}
      <span class="role-name">당신은 ${roleLabel(me.role)}입니다.</span>
      <span class="role-desc">${roleDescription(me.role)}</span>
    </div>
  `;

  let mafiaTeamBox = "";
  if (me.role === "mafia") {
    const teammates = players.filter((p) => p.role === "mafia" && p.id !== playerId);
    mafiaTeamBox = `
      <div class="mafia-team-box">
        🔪 동료 마피아: ${teammates.length ? teammates.map((p) => escapeHtml(p.name)).join(", ") : "없음 (당신 혼자입니다)"}
      </div>
    `;
  }

  const actionArea = renderPlayerAction(code, playerId, game, players, me);

  el.innerHTML = `
    ${renderCodeChip(game.code)}
    ${renderPhaseBanner(game)}
    ${renderCountsRow(game, players)}
    ${myRoleBox}
    ${mafiaTeamBox}
    ${actionArea}
  `;

  wirePlayerAction(code, playerId, game, players, me);
}

function roleDescription(role) {
  if (role === "mafia") return "밤마다 동료와 함께 시민 한 명을 지목해 제거하세요.";
  if (role === "doctor") return "밤마다 한 사람을 선택해 마피아의 공격으로부터 지켜주세요.";
  if (role === "police") return "밤마다 한 사람을 조사해서 정체를 알아내세요.";
  return "낮 동안 대화를 통해 마피아를 찾아내 투표로 지목하세요.";
}

function renderFinalRoster(players) {
  return `
    <div class="panel">
      <h3 style="margin-top:0;">전체 참가자 역할 공개</h3>
      <ul class="player-list">
        ${players
          .map(
            (p) => `<li>${p.alive ? "" : "💀 "}${escapeHtml(p.name)}
              <span class="badge ${p.role}">${roleLabel(p.role)}</span></li>`
          )
          .join("")}
      </ul>
    </div>
  `;
}

function renderPlayerAction(code, playerId, game, players, me) {
  if (!me.alive) {
    return `<div class="waiting-box"><span class="icon">👻</span><p>탈락했습니다. 게임이 끝날 때까지 지켜봐주세요.</p></div>
      ${renderPlayerGrid(players, { mode: "plain", myId: playerId })}`;
  }

  if (game.phase === "day") {
    if (game.daySubphase === "vote" || game.daySubphase === "revote") {
      const myVote = game.votes ? game.votes[playerId] : null;
      const isTie = (game.voteRound || 1) >= 2;
      const candidates = game.voteCandidates || [];
      const votedCount = Object.keys(game.votes || {}).length;
      const eligibleCount = aliveList(players).length;
      const gridPlayers = isTie ? players.filter((p) => !p.alive || candidates.includes(p.id)) : players;
      const tieNames = players.filter((p) => candidates.includes(p.id)).map((p) => p.name).join(", ");
      const tieCount = (game.voteRound || 1) - 1;
      return `
        ${
          isTie
            ? `<div class="tie-banner">🤝 ${tieCount}차 동률 발생! <strong>${escapeHtml(tieNames)}</strong> 중 한 명에게 다시 투표해주세요.</div>`
            : `<p class="center-text sub-text">마피아로 의심되는 사람이 있으면 투표해주세요. 모든 사람이 투표하면 결과가 나옵니다.</p>`
        }
        <p class="center-text sub-text">투표 현황: ${votedCount} / ${eligibleCount}명</p>
        ${renderPlayerGrid(gridPlayers, {
          mode: "day-vote",
          myId: playerId,
          selectedId: myVote,
          candidates,
        })}
      `;
    }
    if (game.daySubphase === "reveal") {
      return renderDayRevealBox(game, players);
    }
  }

  if (game.phase === "night") {
    if (game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") {
      if (me.role === "mafia") {
        const myVote = game.nightVotes ? game.nightVotes[playerId] : null;
        const isTie = (game.nightRound || 1) >= 2;
        const candidates = game.nightCandidates || [];
        const votedCount = Object.keys(game.nightVotes || {}).length;
        const eligibleCount = aliveList(players).filter((p) => p.role === "mafia").length;
        const gridPlayers = isTie ? players.filter((p) => !p.alive || candidates.includes(p.id)) : players;
        const tieNames = players.filter((p) => candidates.includes(p.id)).map((p) => p.name).join(", ");
        const tieCount = (game.nightRound || 1) - 1;
        return `
          ${
            isTie
              ? `<div class="tie-banner">🤝 ${tieCount}차 동률 발생! <strong>${escapeHtml(tieNames)}</strong> 중 한 명에게 다시 투표해주세요.</div>`
              : `<p class="center-text sub-text">제거할 시민을 선택하세요.</p>`
          }
          <p class="center-text sub-text">투표 현황: ${votedCount} / ${eligibleCount}명 (마피아)</p>
          ${renderPlayerGrid(gridPlayers, {
            mode: "night-mafia-vote",
            myId: playerId,
            selectedId: myVote,
            candidates,
          })}
        `;
      }
      const myMafiaDecoy = game.decoyVotes ? game.decoyVotes[playerId] : null;
      return renderDecoyVote(
        players,
        playerId,
        players.filter((p) => p.alive).map((p) => p.id),
        "만약 당신이 마피아라면, 누구를 선택해서 죽이겠습니까?",
        myMafiaDecoy ? myMafiaDecoy.targetId : null,
        false
      );
    }
    if (game.nightSubphase === "mafia_done") {
      const nextIsDoctor = aliveList(players).some((p) => p.role === "doctor");
      return `<div class="waiting-box"><span class="icon">🌙</span><p>모두 눈을 감고 조용히 기다려주세요...</p></div>${renderCountdownText(
        game.revealDeadline,
        nextIsDoctor ? "💉 의사에게 넘어갑니다" : "🔍 경찰에게 넘어갑니다"
      )}`;
    }
    if (game.nightSubphase === "doctor_vote") {
      if (me.role === "doctor") {
        const myVote = game.doctorVotes ? game.doctorVotes[playerId] : null;
        const candidates = players.filter((p) => p.alive).map((p) => p.id);
        const votedCount = Object.keys(game.doctorVotes || {}).length;
        const eligibleCount = aliveList(players).filter((p) => p.role === "doctor").length;
        return `
          <p class="center-text sub-text">누구를 살릴지 선택하세요.</p>
          <p class="center-text sub-text">투표 현황: ${votedCount} / ${eligibleCount}명 (의사)</p>
          ${renderPlayerGrid(players, {
            mode: "night-doctor-vote",
            myId: playerId,
            selectedId: myVote,
            candidates,
          })}
        `;
      }
      const myDoctorDecoy = game.decoyVotes ? game.decoyVotes[playerId] : null;
      if (myDoctorDecoy) {
        return `<div class="waiting-box"><span class="icon">💉</span><p>선택을 완료했습니다. 다른 친구들을 기다려주세요...</p></div>`;
      }
      return renderDecoyVote(
        players,
        playerId,
        players.filter((p) => p.alive).map((p) => p.id),
        "만약 당신이 의사라면, 누구를 선택해서 살리겠습니까?",
        null,
        true
      );
    }
    if (game.nightSubphase === "police_vote") {
      if (me.role === "police") {
        const myCheck = game.policeChecks ? game.policeChecks[playerId] : null;
        if (myCheck) {
          const resultText = myCheck.success
            ? `<p><strong>${escapeHtml(myCheck.targetName)}</strong>님은
                <span class="badge ${myCheck.isMafia ? "mafia" : "citizen"}">${
                myCheck.isMafia ? "마피아" : "마피아 아님"
              }</span> 입니다.</p>`
            : `<p><strong>${escapeHtml(myCheck.targetName)}</strong>님에 대한 조사를 실패했습니다.</p>`;
          return `
            <div class="waiting-box">
              <span class="icon">${myCheck.success ? "🔍" : "❓"}</span>
              ${resultText}
              <p class="sub-text">잘 확인하세요. 다른 경찰이 조사를 마칠 때까지 기다려주세요.</p>
            </div>
            ${renderCountdownText(game.revealDeadline, "다음으로 넘어갑니다")}
          `;
        }
        const candidates = game.policeCandidates || [];
        const votedCount = Object.keys(game.policeChecks || {}).length;
        const eligibleCount = aliveList(players).filter((p) => p.role === "police").length;
        return `
          <p class="center-text sub-text">조사할 사람을 선택하세요. 한 번 선택하면 바꿀 수 없어요.</p>
          <p class="center-text sub-text">조사 현황: ${votedCount} / ${eligibleCount}명 (경찰)</p>
          ${renderPlayerGrid(players, {
            mode: "night-police-vote",
            myId: playerId,
            candidates,
          })}
        `;
      }
      const myPoliceDecoy = game.decoyVotes ? game.decoyVotes[playerId] : null;
      if (myPoliceDecoy) {
        const decoyTargetName = players.find((p) => p.id === myPoliceDecoy.targetId)?.name || "?";
        return `
          <div class="waiting-box">
            <span class="icon">🔍</span>
            <p><strong>${escapeHtml(decoyTargetName)}</strong>님은 <strong>${escapeHtml(myPoliceDecoy.resultText)}</strong></p>
            <p class="sub-text">다른 경찰이 조사를 마칠 때까지 기다려주세요.</p>
          </div>
          ${renderCountdownText(game.revealDeadline, "다음으로 넘어갑니다")}
        `;
      }
      return `
        ${renderDecoyVote(
          players,
          playerId,
          players.filter((p) => p.alive).map((p) => p.id),
          "만약 당신이 경찰이라면, 누구를 선택해서 조사하겠습니까?",
          null,
          true
        )}
        ${renderCountdownText(game.revealDeadline, "다음으로 넘어갑니다")}
      `;
    }
    if (game.nightSubphase === "reveal") {
      return renderNightRevealBox(game, players);
    }
  }

  return `<div class="waiting-box"><span class="icon">⏳</span><p>잠시만 기다려주세요...</p></div>`;
}

// revealDeadline이 있으면(=게임이 아직 진행 중이면) "N초 뒤에 ~"라는 카운트다운 문구를 보여준다.
function renderCountdownText(deadline, label) {
  if (!deadline) return "";
  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return `<div class="countdown-banner">⏳ <strong>${remaining}초</strong> 뒤에 ${label}</div>`;
}

// includeCountdown이 false면 카운트다운 문구를 붙이지 않는다. 관리자 화면에서는
// "진행 조작" 패널에 같은 카운트다운이 버튼과 함께 이미 표시되므로, 위쪽 결과 박스에서는
// 중복으로 뜨지 않도록 뺀다 (참가자 화면에는 진행 조작 패널이 없으므로 항상 표시한다).
function renderDayRevealBox(game, players, includeCountdown = true) {
  const r = game.lastDayResult;
  let inner;
  if (!r || r.noVotes) {
    inner = `<span class="icon">🤷</span><p>아무도 투표하지 않아 탈락자가 없습니다.</p>`;
  } else {
    inner = `
      <span class="icon">${r.eliminatedRole === "mafia" ? "🔪" : "😢"}</span>
      <p><strong>${escapeHtml(r.eliminatedName)}</strong>님이 탈락했습니다.</p>
      <p class="sub-text">정체는 <span class="badge ${r.eliminatedRole}">${roleLabel(r.eliminatedRole)}</span> 였습니다.</p>
    `;
  }
  return `<div class="waiting-box">${inner}</div>${includeCountdown ? renderCountdownText(game.revealDeadline, "🌙 밤이 됩니다") : ""}`;
}

function renderNightRevealBox(game, players, includeCountdown = true) {
  const r = game.lastNightResult;
  let inner;
  if (!r || r.nobody) {
    inner = `<span class="icon">🌅</span><p>어젯밤은 아무 일도 일어나지 않았습니다.</p>`;
  } else if (r.saved) {
    inner = `<span class="icon">💉</span><p>마피아의 공격이 있었지만 의사 선생님이 살렸습니다!</p>`;
  } else if (r.doctorFailed) {
    inner = `
      <span class="icon">💀</span>
      <p>의사 선생님이 <strong>${escapeHtml(r.targetName)}</strong>님을 살리려 했지만 실패했습니다.</p>
      <p class="sub-text">정체는 <span class="badge ${r.targetRole}">${roleLabel(r.targetRole)}</span> 였습니다.</p>
    `;
  } else {
    inner = `
      <span class="icon">💀</span>
      <p><strong>${escapeHtml(r.targetName)}</strong>님이 밤사이 목숨을 잃었습니다.</p>
      <p class="sub-text">정체는 <span class="badge ${r.targetRole}">${roleLabel(r.targetRole)}</span> 였습니다.</p>
    `;
  }
  return `<div class="waiting-box">${inner}</div>${includeCountdown ? renderCountdownText(game.revealDeadline, "☀️ 낮이 됩니다") : ""}`;
}

function wirePlayerAction(code, playerId, game, players, me) {
  if (!me.alive) return;

  const grid = document.querySelector("#playerContent .grid");
  if (!grid) return;

  const mode =
    game.phase === "day" && (game.daySubphase === "vote" || game.daySubphase === "revote")
      ? "day"
      : game.phase === "night" && (game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") && me.role === "mafia"
      ? "night-mafia"
      : game.phase === "night" && game.nightSubphase === "doctor_vote" && me.role === "doctor"
      ? "night-doctor"
      : game.phase === "night" &&
        game.nightSubphase === "police_vote" &&
        me.role === "police" &&
        !(game.policeChecks && game.policeChecks[playerId])
      ? "night-police"
      : game.phase === "night" &&
        (((game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") && me.role !== "mafia") ||
          (game.nightSubphase === "doctor_vote" && me.role !== "doctor" && !(game.decoyVotes && game.decoyVotes[playerId])) ||
          (game.nightSubphase === "police_vote" && me.role !== "police" && !(game.decoyVotes && game.decoyVotes[playerId])))
      ? "decoy"
      : null;

  if (!mode) return;

  // 가짜 투표의 후보 목록은 실제 역할이 무엇이든 "죽은 사람만 빼고" 항상 동일하다.
  // (실제 투표 후보 목록을 그대로 쓰면, 진짜 후보에서 빠진 사람=진짜 역할 수행 대상이라는
  // 것이 드러나서 마피아 등의 정체가 노출될 수 있다.)
  const decoyCandidates = mode === "decoy" ? players.filter((p) => p.alive).map((p) => p.id) : [];

  grid.querySelectorAll(".player-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const targetId = card.dataset.playerId;
      if (targetId === playerId) return;

      if (mode === "decoy") {
        if (!decoyCandidates.includes(targetId)) return;
        // 의사/경찰 차례의 가짜 투표는 실제 의사·경찰처럼 한 번 선택하면 바꿀 수 없다.
        const isLockedPhase = game.nightSubphase === "doctor_vote" || game.nightSubphase === "police_vote";
        if (isLockedPhase && game.decoyVotes && game.decoyVotes[playerId]) return;

        const decoyEntry = { targetId };
        if (game.nightSubphase === "police_vote") {
          // 경찰 차례의 가짜 투표는 실제 조사 결과처럼 보이도록 긍정적인 문구를 랜덤으로 붙인다.
          decoyEntry.resultText = randomDecoyPoliceResult();
        }
        // 가짜 투표도 실제 투표처럼 Firestore에 기록되어야, 전원이 선택을 마쳐야
        // 다음 단계로 넘어가는 "모두 참여" 규칙을 관리자 화면에서 확인할 수 있다.
        await gameRef(code).update({ [`decoyVotes.${playerId}`]: decoyEntry });
        return;
      }

      if (mode === "day") {
        if (!(game.voteCandidates || []).includes(targetId)) return;
        await gameRef(code).update({ [`votes.${playerId}`]: targetId });
      } else if (mode === "night-mafia") {
        if (!(game.nightCandidates || []).includes(targetId)) return;
        await gameRef(code).update({ [`nightVotes.${playerId}`]: targetId });
      } else if (mode === "night-doctor") {
        const target = players.find((p) => p.id === targetId);
        if (!target || !target.alive) return;
        await gameRef(code).update({ [`doctorVotes.${playerId}`]: targetId });
      } else if (mode === "night-police") {
        if (!(game.policeCandidates || []).includes(targetId)) return;
        const target = players.find((p) => p.id === targetId);
        if (!target) return;
        // 조사는 50% 확률로 실패할 수 있다. 성공해도 정확한 직업이 아니라
        // 마피아인지 아닌지만 알려준다.
        const success = Math.random() < 0.5;
        const checkResult = { targetId, targetName: target.name, success };
        if (success) checkResult.isMafia = target.role === "mafia";
        await gameRef(code).update({ [`policeChecks.${playerId}`]: checkResult });
      }
    });
  });
}

/* ------------------------------------------------------------
   시작점: 모든 함수/변수 선언이 끝난 뒤 자동 재접속을 시도한다.
   ------------------------------------------------------------ */
autoResume();
