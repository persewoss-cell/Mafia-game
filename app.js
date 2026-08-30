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

/* ------------------------------------------------------------
   화면 전환
   ------------------------------------------------------------ */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $(id).classList.add("active");
}

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

// 마피아 = 총원/3, 의사 = (총원-마피아)/5, 시민 = 나머지. 소수는 반올림.
function computeRoleCounts(total) {
  const mafiaCount = Math.round(total / 3);
  const remaining = total - mafiaCount;
  const doctorCount = Math.round(remaining / 5);
  const citizenCount = remaining - doctorCount;
  return { mafiaCount, doctorCount, citizenCount };
}

function roleLabel(role) {
  if (role === "mafia") return "마피아";
  if (role === "doctor") return "의사";
  return "시민";
}
function roleEmoji(role) {
  if (role === "mafia") return "🔪";
  if (role === "doctor") return "💉";
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
  $("createError").textContent = "";
  $("inputMaxPlayers").value = "";
  showScreen("screen-create");
});
$("btnGoJoin").addEventListener("click", () => {
  $("joinError").textContent = "";
  $("inputCode").value = "";
  $("inputName").value = "";
  showScreen("screen-join");
});
$("btnBackHome1").addEventListener("click", () => showScreen("screen-home"));
$("btnBackHome2").addEventListener("click", () => showScreen("screen-home"));

/* ------------------------------------------------------------
   게임 생성 (관리자)
   ------------------------------------------------------------ */
$("btnCreateGame").addEventListener("click", async () => {
  const maxPlayers = parseInt($("inputMaxPlayers").value, 10);
  $("createError").textContent = "";

  if (!maxPlayers || maxPlayers < 3) {
    $("createError").textContent = "최소 3명 이상 입력해주세요.";
    return;
  }

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
      lastNightResult: null,
      winner: null,
      winnerTrigger: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    saveSession({ code, role: "admin" });
    startAdminSession(code);
  } catch (err) {
    console.error(err);
    $("createError").textContent = "게임 생성 중 오류가 발생했습니다: " + err.message;
    $("btnCreateGame").disabled = false;
  }
});

/* ------------------------------------------------------------
   게임 참가 (플레이어)
   ------------------------------------------------------------ */
$("btnJoinGame").addEventListener("click", async () => {
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
    if (game.status !== "lobby") {
      $("joinError").textContent = "이미 시작된 게임에는 참가할 수 없습니다.";
      $("btnJoinGame").disabled = false;
      return;
    }

    const existing = await gameRef.collection("players").where("name", "==", name).get();
    if (!existing.empty) {
      $("joinError").textContent = "이미 사용 중인 이름입니다. 다른 이름을 입력해주세요.";
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
(function autoResume() {
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
})();

/* ============================================================
   관리자 세션
   ============================================================ */
let adminUnsubGame = null;
let adminUnsubPlayers = null;

function startAdminSession(code) {
  showScreen("screen-admin");
  if (adminUnsubGame) adminUnsubGame();
  if (adminUnsubPlayers) adminUnsubPlayers();

  let latestGame = null;
  let latestPlayers = [];

  const rerender = () => {
    if (!latestGame) return;
    renderAdmin(code, latestGame, latestPlayers);
  };

  adminUnsubGame = db.collection("games").doc(code).onSnapshot((snap) => {
    if (!snap.exists) {
      alert("게임을 찾을 수 없습니다. 새 게임을 만들어주세요.");
      clearSession();
      showScreen("screen-home");
      return;
    }
    latestGame = snap.data();
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

function renderAdmin(code, game, players) {
  const el = $("adminContent");

  if (game.status === "lobby") {
    el.innerHTML = `
      <div class="title-row">
        <h1>관리자 대기실</h1>
        <p>참가자들에게 아래 코드를 알려주세요</p>
      </div>
      <div class="card">
        <div class="code-display">${game.code}</div>
        <p class="center-text sub-text">목표 인원: ${game.maxPlayers}명 · 현재 참가: ${players.length}명</p>
        <ul class="player-list" id="lobbyPlayerList"></ul>
        <button class="big-btn" id="btnStartGame" ${players.length < 3 ? "disabled" : ""}>
          ${players.length < 3 ? "최소 3명 필요" : "🎬 게임 시작하기"}
        </button>
        <button class="big-btn ghost" id="btnCancelGame">게임 취소하고 나가기</button>
      </div>
    `;
    const list = $("lobbyPlayerList");
    if (players.length === 0) {
      list.innerHTML = `<li class="sub-text">아직 참가자가 없습니다...</li>`;
    } else {
      list.innerHTML = players.map((p) => `<li>🙋 ${escapeHtml(p.name)}</li>`).join("");
    }
    $("btnStartGame").addEventListener("click", () => startGame(code, players));
    $("btnCancelGame").addEventListener("click", async () => {
      if (!confirm("게임을 취소하고 나가시겠습니까?")) return;
      clearSession();
      showScreen("screen-home");
    });
    return;
  }

  if (game.status === "ended") {
    const revealBox = game.winnerTrigger === "night" ? renderNightRevealBox(game) : renderDayRevealBox(game);
    el.innerHTML = revealBox + renderWinnerModalInline(game) + `
      <div class="card center-text">
        <button class="big-btn" id="btnNewGame">🆕 새 게임 만들기</button>
      </div>
      ${renderAdminRoster(players)}
    `;
    $("btnNewGame").addEventListener("click", () => {
      clearSession();
      showScreen("screen-create");
    });
    return;
  }

  // playing
  el.innerHTML = `
    ${renderPhaseBanner(game)}
    ${renderCountsRow(game, players)}
    ${renderPlayerGrid(players, { mode: "admin-view" })}
    ${renderAdminControlPanel(code, game, players)}
    ${renderAdminRoster(players)}
  `;
  wireAdminControlPanel(code, game, players);
}

function renderAdminRoster(players) {
  return `
    <div class="panel">
      <h3 style="margin-top:0;color:#7a54d4;">👑 관리자 전용: 전체 역할 목록</h3>
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

async function startGame(code, players) {
  if (players.length < 3) return;
  const { mafiaCount, doctorCount, citizenCount } = computeRoleCounts(players.length);
  const roles = [
    ...Array(mafiaCount).fill("mafia"),
    ...Array(doctorCount).fill("doctor"),
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
    daySubphase: "discuss",
    dayNumber: 1,
    votes: {},
    voteCandidates: players.map((p) => p.id),
    voteRound: 1,
    winner: null,
  });
  await batch.commit();
}

/* ------------------------------------------------------------
   낮/밤 공통 표시 요소
   ------------------------------------------------------------ */
function renderPhaseBanner(game) {
  if (game.phase === "day") {
    const labels = { discuss: "토론 시간", vote: "투표 시간", revote: "재투표 시간", reveal: "결과 발표" };
    return `<div class="phase-banner">☀️ 낮 ${game.dayNumber}일차 - ${labels[game.daySubphase] || ""}
      <span class="day-num">마피아로 의심되는 사람을 찾아 이야기해보세요</span></div>`;
  }
  if (game.phase === "night") {
    const labels = {
      mafia_vote: "마피아가 대상을 고르는 중",
      mafia_revote: "마피아 재투표 중",
      doctor_vote: "의사가 살릴 사람을 고르는 중",
      reveal: "결과 발표",
    };
    return `<div class="phase-banner">🌙 밤 ${game.dayNumber}일차 - ${labels[game.nightSubphase] || ""}
      <span class="day-num">눈을 감고 조용히 기다려주세요</span></div>`;
  }
  return "";
}

function renderCountsRow(game, players) {
  const total = players.length;
  const aliveCitizen = countByRole(players, "citizen");
  const aliveDoctor = countByRole(players, "doctor");
  return `
    <div class="counts-row">
      <div class="count-pill"><span class="num">${total}</span><span class="label">총 인원</span></div>
      <div class="count-pill"><span class="num">${aliveCitizen}</span><span class="label">생존 시민</span></div>
      <div class="count-pill"><span class="num">${aliveDoctor}</span><span class="label">생존 의사</span></div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// mode: 'admin-view' | 'day-vote' | 'night-mafia-vote' | 'night-doctor-vote' | 'plain'
function renderPlayerGrid(players, opts) {
  const { mode, myId, selectedId, candidates } = opts;
  const showRoleReveal = mode === "admin-view" || mode === "plain-with-reveal";

  return `<div class="grid">
    ${players
      .map((p) => {
        const isDead = !p.alive;
        const isCandidate = candidates ? candidates.includes(p.id) : true;
        const clickable =
          (mode === "day-vote" || mode === "night-mafia-vote" || mode === "night-doctor-vote") &&
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

function renderAdminControlPanel(code, game, players) {
  const alivePlayers = aliveList(players);

  if (game.phase === "day") {
    if (game.daySubphase === "discuss") {
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        <p class="sub-text">충분히 이야기를 나눴다면 투표를 시작하세요.</p>
        <button class="big-btn" id="btnStartVote">🗳️ 투표 시작하기</button>
      </div>`;
    }
    if (game.daySubphase === "vote" || game.daySubphase === "revote") {
      const counts = tally(game.votes, game.voteCandidates);
      const votedCount = Object.keys(game.votes || {}).length;
      const eligibleVoters = alivePlayers.length;
      return `<div class="admin-panel">
        <h3>진행 조작 ${game.voteRound === 2 ? "(재투표)" : ""}</h3>
        <p class="sub-text">투표 현황: ${votedCount} / ${eligibleVoters}명 투표 완료</p>
        ${renderTallyList(counts, players)}
        <button class="big-btn" id="btnCloseVote">✅ 투표 마감하고 결과 확인</button>
      </div>`;
    }
    if (game.daySubphase === "reveal") {
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        <button class="big-btn" id="btnGoNight">🌙 밤으로 진행하기</button>
      </div>`;
    }
  }

  if (game.phase === "night") {
    const aliveMafia = alivePlayers.filter((p) => p.role === "mafia");
    const aliveDoctors = alivePlayers.filter((p) => p.role === "doctor");

    if (game.nightSubphase === "mafia_vote" || game.nightSubphase === "mafia_revote") {
      const counts = tally(game.nightVotes, game.nightCandidates);
      const votedCount = Object.keys(game.nightVotes || {}).length;
      return `<div class="admin-panel">
        <h3>진행 조작 ${game.nightRound === 2 ? "(재투표)" : ""}</h3>
        <p class="sub-text">마피아 투표 현황: ${votedCount} / ${aliveMafia.length}명 투표 완료</p>
        ${renderTallyList(counts, players)}
        <button class="big-btn" id="btnCloseMafiaVote">✅ 마피아 투표 마감</button>
      </div>`;
    }
    if (game.nightSubphase === "doctor_vote") {
      const votedCount = Object.keys(game.doctorVotes || {}).length;
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        <p class="sub-text">의사 선택 현황: ${votedCount} / ${aliveDoctors.length}명 완료</p>
        <button class="big-btn" id="btnCloseDoctorVote">✅ 의사 선택 마감하고 결과 확인</button>
      </div>`;
    }
    if (game.nightSubphase === "reveal") {
      return `<div class="admin-panel">
        <h3>진행 조작</h3>
        <button class="big-btn" id="btnGoDay">☀️ 아침이 밝았습니다 (낮으로)</button>
      </div>`;
    }
  }

  return "";
}

function wireAdminControlPanel(code, game, players) {
  const alivePlayers = aliveList(players);

  const btnStartVote = $("btnStartVote");
  if (btnStartVote) {
    btnStartVote.addEventListener("click", async () => {
      await gameRef(code).update({
        daySubphase: "vote",
        votes: {},
        voteCandidates: alivePlayers.map((p) => p.id),
        voteRound: 1,
      });
    });
  }

  const btnCloseVote = $("btnCloseVote");
  if (btnCloseVote) {
    btnCloseVote.addEventListener("click", () => closeDayVote(code, game, players));
  }

  const btnGoNight = $("btnGoNight");
  if (btnGoNight) {
    btnGoNight.addEventListener("click", async () => {
      const aliveNonMafia = aliveList(players).filter((p) => p.role !== "mafia");
      await gameRef(code).update({
        phase: "night",
        nightSubphase: "mafia_vote",
        nightVotes: {},
        nightCandidates: aliveNonMafia.map((p) => p.id),
        nightRound: 1,
        mafiaTargetId: null,
        doctorVotes: {},
        lastNightResult: null,
      });
    });
  }

  const btnCloseMafiaVote = $("btnCloseMafiaVote");
  if (btnCloseMafiaVote) {
    btnCloseMafiaVote.addEventListener("click", () => closeMafiaVote(code, game, players));
  }

  const btnCloseDoctorVote = $("btnCloseDoctorVote");
  if (btnCloseDoctorVote) {
    btnCloseDoctorVote.addEventListener("click", () => closeDoctorVote(code, game, players));
  }

  const btnGoDay = $("btnGoDay");
  if (btnGoDay) {
    btnGoDay.addEventListener("click", async () => {
      await gameRef(code).update({
        phase: "day",
        daySubphase: "discuss",
        dayNumber: (game.dayNumber || 1) + 1,
        votes: {},
        voteCandidates: [],
        voteRound: 1,
        lastDayResult: null,
      });
    });
  }
}

async function closeDayVote(code, game, players) {
  const counts = tally(game.votes, game.voteCandidates);
  const winners = topVoted(counts);

  if (winners.length === 0) {
    // 아무도 투표하지 않음 -> 탈락자 없음
    await applyDayResult(code, { eliminatedId: null, tie: false, noVotes: true });
    return;
  }

  if (winners.length > 1 && game.voteRound === 1) {
    await gameRef(code).update({
      voteCandidates: winners,
      votes: {},
      voteRound: 2,
    });
    return;
  }

  if (winners.length > 1 && game.voteRound >= 2) {
    await applyDayResult(code, { eliminatedId: null, tie: true });
    return;
  }

  await applyDayResult(code, { eliminatedId: winners[0], tie: false });
}

async function applyDayResult(code, { eliminatedId, tie, noVotes }) {
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
    lastDayResult: { eliminatedId: eliminatedId || null, eliminatedName, eliminatedRole, tie: !!tie, noVotes: !!noVotes },
    status: winner ? "ended" : "playing",
    phase: winner ? "ended" : "day",
    winner: winner || null,
    winnerTrigger: winner ? "day" : null,
  });
}

async function closeMafiaVote(code, game, players) {
  const counts = tally(game.nightVotes, game.nightCandidates);
  const winners = topVoted(counts);

  if (winners.length === 0) {
    await resolveNight(code, { mafiaTargetId: null });
    return;
  }

  if (winners.length > 1 && game.nightRound === 1) {
    await gameRef(code).update({
      nightSubphase: "mafia_revote",
      nightCandidates: winners,
      nightVotes: {},
      nightRound: 2,
    });
    return;
  }

  if (winners.length > 1 && game.nightRound >= 2) {
    await resolveNight(code, { mafiaTargetId: null });
    return;
  }

  const targetId = winners[0];
  const aliveDoctors = aliveList(players).filter((p) => p.role === "doctor");
  if (aliveDoctors.length === 0) {
    await resolveNight(code, { mafiaTargetId: targetId });
  } else {
    await gameRef(code).update({
      mafiaTargetId: targetId,
      nightSubphase: "doctor_vote",
      doctorVotes: {},
    });
  }
}

async function closeDoctorVote(code, game, players) {
  await resolveNight(code, { mafiaTargetId: game.mafiaTargetId, doctorVotes: game.doctorVotes });
}

async function resolveNight(code, { mafiaTargetId, doctorVotes }) {
  const playersSnap = await gameRef(code).collection("players").get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let saved = false;
  let killedName = null;
  let killedRole = null;

  if (mafiaTargetId) {
    const savedSet = new Set(Object.values(doctorVotes || {}));
    saved = savedSet.has(mafiaTargetId);
    if (!saved) {
      await gameRef(code).collection("players").doc(mafiaTargetId).update({ alive: false });
      const p = players.find((pp) => pp.id === mafiaTargetId);
      killedName = p?.name || "";
      killedRole = p?.role || "";
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
      nobody: !mafiaTargetId,
    },
    status: winner ? "ended" : "playing",
    phase: winner ? "ended" : "night",
    winner: winner || null,
    winnerTrigger: winner ? "night" : null,
  });
}

function checkWinner(players) {
  const aliveMafia = players.filter((p) => p.alive && p.role === "mafia").length;
  const aliveOthers = players.filter((p) => p.alive && (p.role === "citizen" || p.role === "doctor")).length;
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

function startPlayerSession(code, playerId) {
  showScreen("screen-player");
  if (playerUnsubGame) playerUnsubGame();
  if (playerUnsubPlayers) playerUnsubPlayers();

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

  playerUnsubGame = db.collection("games").doc(code).onSnapshot((snap) => {
    if (!snap.exists) {
      alert("게임이 삭제되었거나 찾을 수 없습니다.");
      clearSession();
      showScreen("screen-home");
      return;
    }
    latestGame = snap.data();
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

  if (game.status === "lobby") {
    el.innerHTML = `
      <div class="title-row">
        <h1>대기실</h1>
        <p>관리자가 게임을 시작할 때까지 기다려주세요</p>
      </div>
      <div class="card">
        <p class="center-text">참가 코드: <strong>${game.code}</strong></p>
        <p class="center-text sub-text">${players.length}명 참가 중</p>
        <ul class="player-list">
          ${players.map((p) => `<li>🙋 ${escapeHtml(p.name)}${p.id === playerId ? " (나)" : ""}</li>`).join("")}
        </ul>
        <button class="big-btn ghost" id="btnLeaveLobby">나가기</button>
      </div>
    `;
    $("btnLeaveLobby").addEventListener("click", () => {
      clearSession();
      showScreen("screen-home");
    });
    return;
  }

  if (game.status === "ended") {
    const isCitizen = game.winner === "citizen";
    const revealBox = game.winnerTrigger === "night" ? renderNightRevealBox(game) : renderDayRevealBox(game);
    el.innerHTML = `
      ${revealBox}
      <div class="card center-text">
        <span style="font-size:3rem;display:block;">${isCitizen ? "🎉" : "🔪"}</span>
        <h2 class="${isCitizen ? "winner-citizen" : "winner-mafia"}">${isCitizen ? "시민 승리!" : "마피아 승리!"}</h2>
        <p class="sub-text">당신의 역할은 <strong>${roleLabel(me.role)}</strong> 였습니다.</p>
        <button class="big-btn" id="btnLeaveEnded">나가기</button>
      </div>
      ${renderFinalRoster(players)}
    `;
    $("btnLeaveEnded").addEventListener("click", () => {
      clearSession();
      showScreen("screen-home");
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
    if (game.daySubphase === "discuss") {
      return `<div class="waiting-box"><span class="icon">💬</span><p>자유롭게 이야기를 나눠보세요. 관리자가 곧 투표를 시작합니다.</p></div>`;
    }
    if (game.daySubphase === "vote" || game.daySubphase === "revote") {
      const myVote = game.votes ? game.votes[playerId] : null;
      return `
        <p class="center-text sub-text">마피아로 의심되는 사람을 선택해 투표하세요.</p>
        ${renderPlayerGrid(players, {
          mode: "day-vote",
          myId: playerId,
          selectedId: myVote,
          candidates: game.voteCandidates,
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
        return `
          <p class="center-text sub-text">제거할 시민을 선택하세요.</p>
          ${renderPlayerGrid(players, {
            mode: "night-mafia-vote",
            myId: playerId,
            selectedId: myVote,
            candidates: game.nightCandidates,
          })}
        `;
      }
      return `<div class="waiting-box"><span class="icon">🌙</span><p>모두 눈을 감고 조용히 기다려주세요...</p></div>`;
    }
    if (game.nightSubphase === "doctor_vote") {
      if (me.role === "doctor") {
        const myVote = game.doctorVotes ? game.doctorVotes[playerId] : null;
        const candidates = players.filter((p) => p.alive).map((p) => p.id);
        return `
          <p class="center-text sub-text">누구를 살릴지 선택하세요.</p>
          ${renderPlayerGrid(players, {
            mode: "night-doctor-vote",
            myId: playerId,
            selectedId: myVote,
            candidates,
          })}
        `;
      }
      return `<div class="waiting-box"><span class="icon">💉</span><p>의사가 살릴 사람을 고르고 있습니다...</p></div>`;
    }
    if (game.nightSubphase === "reveal") {
      return renderNightRevealBox(game, players);
    }
  }

  return `<div class="waiting-box"><span class="icon">⏳</span><p>잠시만 기다려주세요...</p></div>`;
}

function renderDayRevealBox(game, players) {
  const r = game.lastDayResult;
  if (!r || r.noVotes) {
    return `<div class="waiting-box"><span class="icon">🤷</span><p>아무도 투표하지 않아 탈락자가 없습니다.</p></div>`;
  }
  if (r.tie) {
    return `<div class="waiting-box"><span class="icon">🤝</span><p>재투표에서도 동률이 나와 이번엔 아무도 탈락하지 않았습니다.</p></div>`;
  }
  return `
    <div class="waiting-box">
      <span class="icon">${r.eliminatedRole === "mafia" ? "🔪" : "😢"}</span>
      <p><strong>${escapeHtml(r.eliminatedName)}</strong>님이 탈락했습니다.</p>
      <p class="sub-text">정체는 <span class="badge ${r.eliminatedRole}">${roleLabel(r.eliminatedRole)}</span> 였습니다.</p>
    </div>
  `;
}

function renderNightRevealBox(game, players) {
  const r = game.lastNightResult;
  if (!r || r.nobody) {
    return `<div class="waiting-box"><span class="icon">🌅</span><p>어젯밤은 아무 일도 일어나지 않았습니다.</p></div>`;
  }
  if (r.saved) {
    return `<div class="waiting-box"><span class="icon">💉</span><p>마피아의 공격이 있었지만 의사 선생님이 살렸습니다!</p></div>`;
  }
  return `
    <div class="waiting-box">
      <span class="icon">💀</span>
      <p><strong>${escapeHtml(r.targetName)}</strong>님이 밤사이 목숨을 잃었습니다.</p>
      <p class="sub-text">정체는 <span class="badge ${r.targetRole}">${roleLabel(r.targetRole)}</span> 였습니다.</p>
    </div>
  `;
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
      : null;

  if (!mode) return;

  grid.querySelectorAll(".player-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const targetId = card.dataset.playerId;
      if (targetId === playerId) return;

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
      }
    });
  });
}
