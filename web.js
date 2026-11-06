/* =========================================================
   냉파고 웹사이트 버전 web.js
   - 데이터: data/recipes.json (식약처 공공데이터), data/ai_recipes.json (AI 레시피), data/ingredients.json
   - 한 화면 구성: 왼쪽에서 재료를 담으면 오른쪽 추천이 바로 바뀜, 상세·리포트는 팝업(모달)
   ========================================================= */

const DELIVERY_AVG = 15000; // 배달 1회 평균 비용 (예시 기준값)

const MODES = {
  all:      { label: "전체 추천",   sub: "모든 요리",      emoji: "✨",   img: "",                      color: "var(--mode-all)",      chart: "#7c5cff" },
  saving:   { label: "월급 전",     sub: "생존 모드",      emoji: "💸",   img: "img/mode_saving.png",   color: "var(--mode-saving)",   chart: "#ff7a45" },
  chef:     { label: "오늘은 셰프", sub: "정성 요리 모드", emoji: "👨‍🍳", img: "img/mode_quick.png",    color: "var(--mode-chef)",     chart: "#f5b301" },
  beginner: { label: "요리 초보",   sub: "간편 모드",      emoji: "🐣",   img: "img/mode_beginner.png", color: "var(--mode-beginner)", chart: "#2fb36d" },
  dish:     { label: "설거지",      sub: "최소 모드",      emoji: "🧽",   img: "img/mode_dish.png",     color: "var(--mode-dish)",     chart: "#2f80ff" },
};
const MODE_ORDER = ["all", "saving", "chef", "beginner", "dish"];

const state = {
  recipes: [], master: null, allNames: [],
  my: new Set(), urgent: new Set(), pantry: true,
  mode: "all", cat: null, results: [], current: null, photoFound: [], charts: {}, lastOneMore: null,
};

/* ---------------- 공통 유틸 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const num = (n) => n.toLocaleString("ko-KR");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 무시 */ } },
};
function applyImages(root = document) {
  root.querySelectorAll("[data-img]").forEach((el) => {
    const src = el.dataset.img;
    if (!src || el.dataset.loaded) return;
    const img = new Image();
    img.onload = () => { el.innerHTML = ""; el.appendChild(img); el.dataset.loaded = "1"; };
    img.alt = "냉파고 캐릭터";
    img.src = src;
  });
}

/* ---------------- 재료 이름 ---------------- */
const isPantry = (n) => state.master.pantry.includes(n);
function normalize(raw) {
  const n = String(raw).replace(/\s/g, "");
  return state.master.synonyms[n] || n;
}
function extractIngredients(text) {
  let rest = String(text).replace(/\s/g, "");
  const found = new Set();
  for (const name of state.allNames) {
    if (rest.includes(name)) {
      const n = normalize(name);
      if (!isPantry(n)) found.add(n);
      rest = rest.split(name).join("_");
    }
  }
  return [...found];
}

/* ---------------- 재료 담기 ---------------- */
const catLabel = (c) => c.replace(/^[^가-힣A-Za-z]+/, "").trim();

function renderChips() {
  const cats = Object.keys(state.master.categories);
  if (!state.cat) state.cat = cats[0];
  $("#cat-tabs").innerHTML = cats.map((c) =>
    `<button class="cat-tab ${c === state.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(catLabel(c))}</button>`).join("");
  $("#chip-list").innerHTML = state.master.categories[state.cat]
    .map((i) => `<button class="chip ${state.my.has(i) ? "on" : ""}" data-chip="${esc(i)}">${esc(i)}</button>`).join("");
}

function renderBasket(popName) {
  $("#basket-count").textContent = state.my.size;
  const nc = $("#nav-count"); // 상단 내비바 장바구니 숫자
  if (nc) { nc.textContent = state.my.size; nc.toggleAttribute("data-zero", !state.my.size); }
  const box = $("#basket");
  if (!state.my.size) { box.innerHTML = `<p class="empty-text">아직 비어 있어요. 위에서 재료를 골라주세요.</p>`; return; }
  box.innerHTML = [...state.my].map((i) => {
    const u = state.urgent.has(i);
    return `<span class="chip ${u ? "urgent" : "soft"} ${i === popName ? "pop" : ""}">
      <button data-urgent="${esc(i)}" title="빨리 써야 하면 눌러요">${u ? "⏰ " : ""}${esc(i)}</button>
      <button class="x" data-remove="${esc(i)}" title="빼기">✕</button></span>`;
  }).join("");
}

function save() { store.set("npgw_fridge", { my: [...state.my], urgent: [...state.urgent], pantry: state.pantry }); }

function refresh(popName) {
  save();
  renderChips();
  renderBasket(popName);
  updatePreview();
  if (currentScreen() === "result") renderResults();
}

// 재료 화면 오른쪽: "지금 바로 만들 수 있는 요리 N개" 미리보기
function updatePreview() {
  const box = $("#preview-box");
  if (!box) return;
  if (!state.my.size) { box.textContent = "재료를 담으면 만들 수 있는 요리 수를 알려드려요"; return; }
  const ready = state.recipes.map(analyze).filter((a) => a.have.length && !a.missing.length).length;
  box.innerHTML = ready ? `지금 바로 만들 수 있는 요리 <b>${num(ready)}개</b>` : `아직 바로 만들 요리가 없어요. 재료를 더 담아보세요!`;
}

function addItems(names) {
  let added = 0, last = null;
  names.forEach((raw) => {
    const n = normalize(raw);
    if (!n || isPantry(n) || state.my.has(n)) return;
    state.my.add(n); added++; last = n;
  });
  if (added) refresh(last);
  return added;
}
function toggleItem(n) {
  if (state.my.has(n)) { state.my.delete(n); state.urgent.delete(n); refresh(); }
  else { state.my.add(n); refresh(n); }
}

/* 음성 입력 (크롬 Web Speech API – https 또는 localhost에서 동작) */
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("이 브라우저는 음성 입력을 지원하지 않아요. 크롬을 써주세요.");
  const rec = new SR();
  rec.lang = "ko-KR";
  $("#voice-btn").textContent = "👂 듣는 중...";
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    const found = extractIngredients(text);
    const added = addItems(found);
    $("#voice-text").innerHTML = `"${esc(text)}"<br><b>${found.length ? found.map(esc).join(", ") : "찾은 재료 없음"}</b>`;
    toast(added ? `재료 ${added}개를 담았어요` : "새로 담을 재료가 없어요");
  };
  rec.onerror = () => toast("음성을 인식하지 못했어요. 다시 시도해 주세요.");
  rec.onend = () => { $("#voice-btn").textContent = "🎤 말하기 시작"; };
  rec.start();
}

/* 사진 입력 → /api/vision (Vercel 서버리스 함수, 키가 있을 때만) */
function resizeImage(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject; img.src = r.result;
    };
    r.onerror = reject; r.readAsDataURL(file);
  });
}
function showPhotoResult(list, label) {
  state.photoFound = list;
  $("#photo-status").textContent = label;
  $("#photo-result").innerHTML = list.map((i) => `<span class="chip on">${esc(i)}</span>`).join("");
  $("#photo-add-btn").classList.toggle("hidden", !list.length);
}
async function handlePhoto(file) {
  if (!file) return;
  const url = await resizeImage(file);
  const pv = $("#photo-preview"); pv.src = url; pv.classList.remove("hidden");
  showPhotoResult([], "🔎 AI가 재료를 찾는 중...");
  try {
    const res = await fetch("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: url }) });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const found = extractIngredients((data.ingredients || []).join(" "));
    showPhotoResult(found, found.length ? "이 재료들이 보여요. 맞으면 담아주세요." : "재료를 찾지 못했어요. 직접 골라주세요.");
  } catch {
    showPhotoResult([], "사진 인식 서버가 아직 연결되지 않았어요. '고르기'에서 직접 담거나 예시 사진으로 체험해 보세요.");
  }
}
async function demoPhoto() {
  try {
    const demo = await (await fetch("data/demo_vision.json")).json();
    const pv = $("#photo-preview");
    pv.onerror = () => pv.classList.add("hidden");
    pv.src = demo.image; pv.classList.remove("hidden");
    showPhotoResult(demo.ingredients.map(normalize), `📌 예시 결과입니다 · ${demo.model}`);
  } catch { toast("예시 데이터를 불러오지 못했어요."); }
}

/* ---------------- 추천 로직 ---------------- */
const priceOf = (n) => state.master.prices[n] ?? null;
const costOf = (names) => names.reduce((s, i) => s + (priceOf(i) ?? 0), 0);
function priceText(names) {
  const unknown = names.some((i) => priceOf(i) === null);
  const known = costOf(names);
  if (unknown && !known) return "가격 정보 없음";
  return `약 ${won(known)}${unknown ? " + α" : ""}`;
}
const mainIngs = (r) => r.ingredients.filter((i) => !(state.pantry && isPantry(i)));

function analyze(recipe) {
  const ings = mainIngs(recipe);
  const have = ings.filter((i) => state.my.has(i));
  const missing = ings.filter((i) => !state.my.has(i));
  return {
    recipe, have, missing,
    coverage: ings.length ? have.length / ings.length : 0,
    urgentUsed: have.filter((i) => state.urgent.has(i)),
    extraCost: costOf(missing),
  };
}
function passMode(a, mode) {
  const r = a.recipe;
  if (mode === "chef") return r.minutes >= 15 || r.difficulty !== "초보";
  if (mode === "beginner") return r.difficulty === "초보";
  if (mode === "dish") return (r.tools || []).length <= 1;
  if (mode === "saving") return a.missing.length <= 1;
  return true;
}
// 정성 점수: 조리시간이 길고, 재료가 다양하고, 난이도가 높을수록
function effortOf(r) {
  const main = r.ingredients.filter((i) => !isPantry(i)).length;
  const diff = { 초보: 0, 보통: 0.5, 도전: 1 }[r.difficulty] ?? 0.5;
  return 0.4 * Math.min((r.minutes || 0) / 60, 1) + 0.35 * Math.min(main / 6, 1) + 0.25 * diff;
}
function score(a, mode) {
  const urgentN = state.urgent.size ? a.urgentUsed.length / state.urgent.size : 0;
  const useN = state.my.size ? Math.min(a.have.length / state.my.size, 1) : 0;
  if (mode === "chef") return 0.5 * a.coverage + 0.1 * urgentN + 0.15 * useN + 0.45 * effortOf(a.recipe);
  const w = mode === "saving" ? { c: 0.45, u: 0.15, cost: 0.3, j: 0.1 } : { c: 0.6, u: 0.2, cost: 0.1, j: 0.1 };
  const costN = Math.min((a.extraCost + a.missing.filter((i) => priceOf(i) === null).length * 3000) / 10000, 1);
  const j = (a.recipe.jachwi_score || 3) / 5;
  return w.c * a.coverage + w.u * urgentN + w.cost * (1 - costN) + w.j * j + 0.15 * useN;
}
// 바로 가능 = 기본 양념 뺀 재료를 전부 가진 요리 / 1개만 사면 = 부족한 재료가 딱 1개
function recommend(mode) {
  const ranked = state.recipes.map(analyze)
    .filter((a) => a.have.length > 0 && passMode(a, mode))
    .map((a) => ({ ...a, score: score(a, mode) }))
    .sort((x, y) => y.score - x.score);
  return {
    ready: ranked.filter((a) => a.missing.length === 0).slice(0, 9),
    almost: ranked.filter((a) => a.missing.length === 1).slice(0, 6),
  };
}
function oneMore(mode) {
  const all = state.recipes.map(analyze).filter((a) => passMode({ ...a, missing: [] }, mode));
  const now = all.filter((a) => a.missing.length === 0).length;
  const gain = {};
  all.filter((a) => a.missing.length === 1).forEach((a) => { gain[a.missing[0]] = (gain[a.missing[0]] || 0) + 1; });
  const best = Object.entries(gain).sort((x, y) => y[1] - x[1] || (priceOf(x[0]) ?? 9999) - (priceOf(y[0]) ?? 9999))[0];
  return best ? { item: best[0], before: now, after: now + best[1], price: priceText([best[0]]) } : null;
}
function reasonOf(a) {
  if (a.missing.length) return `${a.missing.join(", ")}만 사면 돼요 (${priceText(a.missing)})`;
  if (a.urgentUsed.length) return `⏰ 빨리 써야 하는 ${a.urgentUsed.join(", ")} 구조!`;
  if (state.mode === "chef" && a.missing.length === 0) return `👨‍🍳 ${a.recipe.minutes}분 정성 요리, 재료는 다 있어요`;
  if (a.missing.length === 0) return "추가 구매 0원, 바로 가능";
  return `${a.missing.join(", ")}만 사면 돼요 (${priceText(a.missing)})`;
}

/* ---------------- 화면 그리기 ---------------- */
function thumbHTML(r, cls) {
  const e = esc(r.emoji || "🍽️");
  if (!r.image) return `<div class="${cls}">${e}</div>`;
  return `<div class="${cls}"><img src="${esc(r.image)}" alt="${esc(r.name)}" loading="lazy" onerror="this.parentNode.textContent='${e}'"></div>`;
}
const srcTag = (r) => (r.source === "ai" ? `<span class="tag ai">🤖 AI 레시피</span>` : `<span class="tag public">🏛 공공데이터</span>`);

const MODE_DESC = {
  saving: "추가 지출을 최소로, 있는 재료로 버티는 날",
  chef: "시간 제한 없이 정성 들여 제대로 해 먹는 날",
  beginner: "쉽고 간단한 요리만, 실패 없는 한 끼",
  dish: "조리도구 1개 이하로 설거지 최소화",
};
function renderModes() {
  $("#mode-grid").innerHTML = ["saving", "chef", "beginner", "dish"].map((k) => {
    const m = MODES[k];
    return `<button class="mode-card" data-mode="${k}">
      <div class="mode-img" style="background:${m.color}" data-img="${m.img}"><span class="emoji-fallback">${m.emoji}</span></div>
      <b>${m.label}</b><span>${m.sub}</span><em>${MODE_DESC[k]}</em></button>`;
  }).join("");
  applyImages($("#mode-grid"));
}
function renderSide() {
  const m = MODES[state.mode];
  $("#result-mode-title").textContent = `${m.emoji} ${m.label} ${state.mode === "all" ? "" : m.sub}`;
  $("#side-basket").innerHTML = [...state.my].map((i) => `<span class="chip ${state.urgent.has(i) ? "urgent" : "soft"}">${state.urgent.has(i) ? "⏰ " : ""}${esc(i)}</span>`).join("");
  $("#mode-pills").innerHTML = MODE_ORDER.map((k) => `<button class="${state.mode === k ? "active" : ""}" data-mode="${k}">${MODES[k].emoji} ${MODES[k].label}</button>`).join("");
}

function cardHTML(a, idx) {
  const r = a.recipe;
  const ings = mainIngs(r).map((i) => (state.my.has(i) ? `✓${esc(i)}` : `<span class="no">🛒${esc(i)}</span>`)).join(" · ");
  const tool = (r.tools || []).length ? r.tools.join("·") : "도구 거의 없음";
  return `<button class="recipe-card" data-detail="${idx}">
    ${thumbHTML(r, "thumb")}
    <div class="recipe-body">
      <div class="name">${esc(r.name)}</div>
      <div class="tags">${srcTag(r)}<span class="tag">⏱ ${r.minutes}분</span><span class="tag">${esc(r.difficulty)}</span><span class="tag">🍳 ${esc(tool)}</span></div>
      <div class="ing-line">${ings}</div>
      <div class="reason">${esc(reasonOf(a))}</div>
    </div></button>`;
}

function renderResults() {
  renderSide();
  const list = $("#result-list");
  const omBox = $("#one-more");
  if (!state.my.size) {
    omBox.classList.add("hidden");
    list.innerHTML = `<div class="empty-card"><div class="big">🧊</div>왼쪽에서 냉장고에 있는 재료를 담아주세요.<br>담는 즉시 여기에 만들 수 있는 요리가 나타나요.</div>`;
    return;
  }
  const { ready, almost } = recommend(state.mode);
  state.results = [...ready, ...almost];

  const om = oneMore(state.mode);
  state.lastOneMore = om;
  if (om && om.after > om.before) {
    omBox.innerHTML = `<span class="bulb">💡</span><div><b>${esc(om.item)} 하나만 사면</b>
      <p>바로 만들 수 있는 요리 ${om.before}개 → ${om.after}개 (${esc(om.price)})</p></div>
      <span class="add">＋ 냉장고에 담아보기</span>`;
    omBox.classList.remove("hidden");
  } else omBox.classList.add("hidden");

  let html = `<div class="result-head"><h3>🍳 지금 바로 만들 수 있어요</h3><span>${ready.length}개 · ${MODES[state.mode].label}</span></div>`;
  html += `<div class="result-grid">${ready.length ? ready.map((a, i) => cardHTML(a, i)).join("")
    : `<div class="empty-card"><div class="big">🥲</div>담은 재료만으로 만들 수 있는 요리는 아직 없어요.<br>재료를 더 담거나 아래 요리를 참고해 보세요.</div>`}</div>`;
  if (almost.length) {
    html += `<div class="result-head"><h3>🛒 재료 1개만 더 있으면</h3><span>${almost.length}개</span></div>`;
    html += `<div class="result-grid">${almost.map((a, i) => cardHTML(a, ready.length + i)).join("")}</div>`;
  }
  list.innerHTML = html;
}

/* 상세 모달 */

function renderDetail(a) {
  state.current = a;
  const r = a.recipe;
  const subs = Object.entries(r.substitutes || {});
  const ai = r.source === "ai";
  $("#detail").innerHTML = `
    <div class="detail-grid">
      <div>${thumbHTML(r, "detail-hero")}
        <p class="meta-line" style="margin-top:14px">⏱ ${r.minutes}분 · ${esc(r.difficulty)} · ${(r.tools || []).length ? esc(r.tools.join(", ")) : "도구 거의 없음"}${r.kcal ? ` · ${r.kcal}kcal` : ""}</p>
        ${subs.length ? `<p class="meta-line">⇄ 대체 재료: ${subs.map(([k, v]) => `${esc(k)} → ${esc(v)}`).join(", ")}</p>` : ""}
      </div>
      <div>
        <div class="tags">${srcTag(r)}</div>
        <h2 class="detail-name">${esc(r.name)}</h2>
        <div class="need">
          ${a.have.map((i) => `<span class="ing">✓ ${esc(i)}</span>`).join("")}
          ${a.missing.map((i) => `<span class="ing miss">🛒 ${esc(i)}</span>`).join("")}
        </div>
        <div class="steps-card">
          <h3>${ai ? "초보용 조리법" : "조리법"}<span class="src-tag">${ai ? "AI 생성" : "출처: 식품안전나라"}</span></h3>
          <ol class="steps">${(r.easy_steps || []).map((s, i) => `<li><input type="checkbox" aria-label="${i + 1}단계"><span>${i + 1}. ${esc(s)}</span></li>`).join("")}</ol>
        </div>
      </div>
    </div>`;
  showScreen("detail");
}

/* 구조 리포트 + 꽃가루 */
function confetti() {
  const items = ["🎉", "✨", "🥚", "🧅", "🥕", "⭐"];
  for (let i = 0; i < 36; i++) {
    const s = document.createElement("span");
    s.className = "confetti";
    s.textContent = items[i % items.length];
    s.style.left = Math.random() * 100 + "vw";
    s.style.animationDuration = 1.8 + Math.random() * 1.6 + "s";
    s.style.animationDelay = Math.random() * 0.4 + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 4000);
  }
}
function finishCooking() {
  const a = state.current;
  if (!a) return;
  const rescued = a.have.length, urgentRescued = a.urgentUsed.length;
  const saved = Math.max(DELIVERY_AVG - a.extraCost, 0);
  a.have.forEach((i) => { state.my.delete(i); state.urgent.delete(i); });
  const total = store.get("npgw_total", { saved: 0, count: 0 });
  total.saved += saved; total.count += 1;
  store.set("npgw_total", total);
  const badge = urgentRescued ? "유통기한 구조 요원" : rescued >= 3 ? "냉장고 털기 장인" : "냉털 새싹";
  $("#report-card").innerHTML = `
    <div class="report-img-wrap">
      <div class="report-img" data-img="img/mascot_main.png"><span class="emoji-fallback">🛟</span></div>
      <div class="stamp"><span class="stamp-top">NAENGPAGO</span><b>${badge}</b><span class="stamp-bottom">★ 구조 완료 ★</span></div>
    </div>
    <h2 class="report-title">🛟 오늘의 구조 리포트</h2>
    <p class="report-dish">${esc(a.recipe.name)} 완성!</p>
    <div class="report-grid">
      <div class="report-box"><span>구조한 재료</span><b>${rescued}개</b></div>
      <div class="report-box"><span>추가 지출</span><b>${a.missing.length ? esc(priceText(a.missing).replace("약 ", "")) : "0원"}</b></div>
    </div>
    <div class="saved-box"><span>배달 대신 아낀 돈</span><b>약 ${won(saved)}</b><small>배달 1회 평균 ${won(DELIVERY_AVG)} 기준(예시)</small></div>
        <p class="report-total">누적 ${total.count}끼 · 아낀 돈 ${won(total.saved)} · 냉파고</p>`;
  applyImages($("#report-card"));
  const rc = $("#report-card"); rc.classList.remove("shake"); void rc.offsetWidth; rc.classList.add("shake"); // 도장 찍힐 때 살짝 흔들림
  save();
  renderChips();
  renderBasket();
  updatePreview();
  showScreen("report");
  confetti();
}
function saveReport() {
  if (!window.html2canvas) return toast("이미지 저장 기능을 불러오지 못했어요.");
  html2canvas($("#report-card"), { backgroundColor: null, scale: 2, useCORS: true }).then((c) => {
    const l = document.createElement("a");
    l.download = "naengpago_report.png"; l.href = c.toDataURL("image/png"); l.click();
  });
}

/* 데이터랩 */
function renderLab() {
  const recipes = state.recipes;
  const aiN = recipes.filter((r) => r.source === "ai").length;
  $("#lab-summary").textContent = `공공데이터 ${num(recipes.length - aiN)}개 + AI 레시피 ${num(aiN)}개, 총 ${num(recipes.length)}개 레시피를 분석했어요.`;
  const freq = {}, pairs = {};
  recipes.forEach((r) => {
    const ings = [...new Set(r.ingredients.filter((i) => !isPantry(i)))].sort();
    ings.forEach((i) => { freq[i] = (freq[i] || 0) + 1; });
    for (let x = 0; x < ings.length; x++) for (let y = x + 1; y < ings.length; y++) {
      const k = `${ings[x]} + ${ings[y]}`; pairs[k] = (pairs[k] || 0) + 1;
    }
  });
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = top.length ? top[0][1] : 1;
  $("#bar-list").innerHTML = top.map(([n, c]) => `<div class="bar-row"><span>${esc(n)}</span><div class="track"><div class="fill" style="width:${(c / max) * 100}%"></div></div><em>${c}</em></div>`).join("");
  $("#pair-list").innerHTML = Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `<li>${esc(k)} <span class="help small">(${v}개)</span></li>`).join("");
  const keys = ["saving", "chef", "beginner", "dish"];
  const counts = keys.map((k) => recipes.filter((r) => (k === "saving"
    ? r.ingredients.filter((i) => !isPantry(i)).length <= 3
    : passMode({ recipe: r, missing: [] }, k))).length);
  $("#mode-legend").innerHTML = keys.map((k, i) => `<li><i style="background:${MODES[k].chart}"></i>${MODES[k].label} ${MODES[k].sub} <b>${num(counts[i])}</b></li>`).join("");
  if (window.Chart) {
    state.charts.mode?.destroy();
    state.charts.mode = new Chart($("#chart-mode"), {
      type: "doughnut",
      data: { labels: keys.map((k) => MODES[k].label), datasets: [{ data: counts, backgroundColor: keys.map((k) => MODES[k].chart), borderColor: "#ffffff", borderWidth: 2 }] },
      options: { responsive: false, cutout: "58%", plugins: { legend: { display: false } } },
    });
  }
}

/* ---------------- 화면 전환 (앱처럼 한 화면씩) ---------------- */
const SCREENS = ["home", "fridge", "mode", "result", "detail", "report", "lab", "about"];
const STEP_ORDER = { fridge: 1, mode: 2, result: 3, detail: 3, report: 3 };
const currentScreen = () => (document.querySelector(".screen:not(.hidden)")?.id || "").replace("screen-", "");

// 데이터랩·서비스 소개는 첫 화면(home) 아래쪽 구역으로 스크롤
const HOME_SECTIONS = { about: "#home-about", lab: "#home-lab" };

function showScreen(name, push = true) {
  if (!SCREENS.includes(name)) name = "home";
  const route = name; // 주소창(#lab 등)에 남길 이름
  const section = HOME_SECTIONS[name];
  if (section) name = "home";
  // 순서를 건너뛸 수 없는 화면 보호
  if ((name === "mode" || name === "result") && !state.my.size) { toast("먼저 재료를 담아주세요"); name = "fridge"; }
  if (name === "detail" && !state.current) name = state.my.size ? "result" : "fridge";
  if (name === "report" && !$("#report-card").innerHTML.trim()) name = "home";

  $$(".screen").forEach((sc) => sc.classList.add("hidden"));
  document.body.dataset.screen = name; // 표지(home)에서는 푸터를 숨김
  const el = $(`#screen-${name}`);
  el.classList.remove("hidden");
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; // 등장 애니메이션 다시 재생

  // 상단 진행 단계 표시
  const now = STEP_ORDER[name] || 0;
  $$("#stepper li").forEach((li) => {
    const n = STEP_ORDER[li.dataset.step];
    li.classList.toggle("now", n === now);
    li.classList.toggle("done", now > 0 && n < now);
  });
  const activeKey = section ? route : name; // 메뉴에서 강조할 항목
  $$(".nav-links button").forEach((b) => b.classList.toggle("active", activeKey !== "home" && b.dataset.go === activeKey));

  if (name === "home") startFridge();
  if (name === "fridge") { renderChips(); renderBasket(); updatePreview(); }
  if (name === "mode") renderModes();
  if (name === "result") renderResults();
  if (name === "home") renderLab();

  if (push && location.hash !== `#${route}`) history.pushState(null, "", `#${route}`);
  if (section) requestAnimationFrame(() => $(section).scrollIntoView({ behavior: "smooth", block: "start" }));
  else window.scrollTo({ top: 0, behavior: "instant" });
}

/* 첫 화면에서 지금 보고 있는 구역(서비스 소개/데이터랩)을 메뉴에 표시 */
function watchHomeSections() {
  if (!window.IntersectionObserver) return;
  const io = new IntersectionObserver((entries) => {
    if (currentScreen() !== "home") return;
    entries.forEach((en) => {
      const key = en.target.id.replace("home-", "");
      $$(".nav-links button").forEach((b) => { if (b.dataset.go === key) b.classList.toggle("active", en.isIntersecting); });
    });
  }, { rootMargin: "-45% 0px -45% 0px" });
  Object.values(HOME_SECTIONS).forEach((sel) => $(sel) && io.observe($(sel)));
}

/* 첫 화면 냉장고: 2초 뒤 덜컹, 3초 뒤 문이 열림 */
function startFridge() {
  const f = $("#hero-fridge");
  if (!f || f.classList.contains("open")) return;
  clearTimeout(state.fridgeT1); clearTimeout(state.fridgeT2);
  state.fridgeT1 = setTimeout(() => f.classList.add("ready"), 2000);
  state.fridgeT2 = setTimeout(() => f.classList.add("open"), 3000);
}

/* ---------------- 이벤트 ---------------- */
function bindEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, .one-more");
    if (!t) return;
    if (t.id === "one-more") {
      const om = state.lastOneMore;
      if (om && addItems([om.item])) toast(`${om.item}을(를) 담았어요`);
      return;
    }
    const d = t.dataset;
    if (d.go) return showScreen(d.go);
    if (d.cat) { state.cat = d.cat; return renderChips(); }
    if (d.chip) return toggleItem(d.chip);
    if (d.remove) { state.my.delete(d.remove); state.urgent.delete(d.remove); return refresh(); }
    if (d.urgent) { state.urgent.has(d.urgent) ? state.urgent.delete(d.urgent) : state.urgent.add(d.urgent); return refresh(); }
    if (d.tab) {
      $$(".seg").forEach((b) => b.classList.toggle("active", b === t));
      $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
      return $(`#panel-${d.tab}`).classList.remove("hidden");
    }
    if (d.mode) { state.mode = d.mode; return currentScreen() === "result" ? renderResults() : showScreen("result"); }
    if (d.detail !== undefined) return renderDetail(state.results[Number(d.detail)]);
  });
  $("#fridge-door")?.addEventListener("click", () => $("#hero-fridge").classList.add("open"));
  // 모바일 메뉴(Bootstrap drawer): 열기·닫기, 메뉴를 누르면 자동으로 닫힘
  const drawer = $("#drawer");
  const closeDrawer = () => { if (drawer?.open) drawer.close(); };
  $("#drawer-open")?.addEventListener("click", () => { if (drawer && !drawer.open) drawer.showModal(); });
  $("#drawer-close")?.addEventListener("click", closeDrawer);
  drawer?.addEventListener("click", (e) => { if (e.target === drawer || e.target.closest("[data-go]")) closeDrawer(); });
  $("#to-mode").addEventListener("click", () => (state.my.size ? showScreen("mode") : toast("재료를 하나 이상 담아주세요")));
  $("#again-btn").addEventListener("click", () => showScreen(state.my.size ? "result" : "fridge"));
  window.addEventListener("popstate", () => showScreen(location.hash.replace("#", "") || "home", false));

  const addSearch = () => {
    const v = $("#search-input").value.trim();
    if (!v) return;
    addItems([v]) ? toast(`${normalize(v)} 담았어요`) : toast("이미 담겼거나 기본 양념이에요");
    $("#search-input").value = "";
  };
  $("#search-add").addEventListener("click", addSearch);
  $("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addSearch(); });
  $("#basket-clear").addEventListener("click", () => { state.my.clear(); state.urgent.clear(); refresh(); });
  $("#pantry-check").addEventListener("change", (e) => { state.pantry = e.target.checked; refresh(); });
  $("#voice-btn").addEventListener("click", startVoice);
  $("#photo-input").addEventListener("change", (e) => handlePhoto(e.target.files[0]));
  $("#demo-photo-btn").addEventListener("click", demoPhoto);
  $("#photo-add-btn").addEventListener("click", () => { const n = addItems(state.photoFound); toast(n ? `재료 ${n}개를 담았어요` : "이미 다 담겨 있어요"); });
  $("#detail").addEventListener("change", (e) => { if (e.target.type === "checkbox") e.target.closest("li").classList.toggle("checked", e.target.checked); });
  $("#done-btn").addEventListener("click", finishCooking);
  $("#save-report").addEventListener("click", saveReport);
}

/* ---------------- 시작 ---------------- */
async function init() {
  try {
    const [recipes, master] = await Promise.all([
      fetch("data/recipes.json").then((r) => r.json()),
      fetch("data/ingredients.json").then((r) => r.json()),
    ]);
    let ai = [];
    try { ai = await fetch("data/ai_recipes.json").then((r) => r.json()); } catch { /* 없으면 공공데이터만 */ }
    // 같은 이름의 요리가 공공데이터와 AI에 모두 있으면 공공데이터 쪽만 남김
    const publicNames = new Set(recipes.map((r) => r.name.replace(/\s/g, "")));
    state.recipes = [
      ...recipes.map((r) => ({ ...r, source: r.source || "public" })),
      ...ai.filter((r) => !publicNames.has(r.name.replace(/\s/g, ""))).map((r) => ({ ...r, source: "ai" })),
    ];
    state.master = master;
  } catch (err) {
    console.error(err);
    $("#result-list").innerHTML = `<div class="empty-card">데이터를 불러오지 못했어요.<br>VS Code에서 <b>Live Server</b>로 열거나, <b>python scripts/make_offline.py</b>를 실행한 뒤 다시 열어주세요.</div>`;
    return;
  }
  const names = new Set([...Object.values(state.master.categories).flat(), ...Object.keys(state.master.synonyms),
    ...state.master.pantry, ...state.recipes.flatMap((r) => r.ingredients)]);
  state.allNames = [...names].sort((a, b) => b.length - a.length);
  $("#ingredient-list").innerHTML = [...names].filter((n) => !isPantry(normalize(n))).map((n) => `<option value="${esc(n)}">`).join("");

  const aiN = state.recipes.filter((r) => r.source === "ai").length;
  const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  setText("#stat-public", num(state.recipes.length - aiN));
  setText("#stat-ai", num(aiN));
  setText("#stat-ings", num(new Set(state.recipes.flatMap((r) => mainIngs(r))).size));

  // 새로고침할 때마다 내 냉장고는 빈 상태로 시작 (이전에 담은 재료를 불러오지 않음)
  // 표지 높이를 정확히 맞추기 위해 상단 메뉴 높이를 CSS 변수로 전달
  const setNavH = () => document.documentElement.style.setProperty("--nav-h", `${document.querySelector(".navbar")?.offsetHeight || 56}px`);
  setNavH(); window.addEventListener("resize", setNavH);
  bindEvents();
  watchHomeSections();
  applyImages();
  save();
  showScreen(location.hash.replace("#", "") || "home", false);
}
init();