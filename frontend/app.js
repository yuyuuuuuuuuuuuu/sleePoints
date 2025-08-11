// ---------- utils ----------
const fmtDT = (iso) => {
  try { return new Date(iso).toLocaleString([], { hour12: false }); }
  catch { return iso; }
};
const toMins = (d) => d.getHours() * 60 + d.getMinutes();
const mmToHHMM = (mins) => {
  // 0..1440 はそのまま、負の値は「前日」表記に
  let m = mins;
  let prefix = "";
  if (m < 0) { m += 1440; prefix = "(-1) "; } // 前日
  const h = Math.floor(m / 60), mi = Math.round(m % 60);
  return `${prefix}${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---------- header points ----------
async function refreshMe() {
  const me = await api("/api/me");
  const el = document.getElementById("points");
  if (el) el.textContent = `${me.points.toFixed(1)} pts`;
}

// ---------- sleep chart (bedtime + wake + duration) ----------
let sleepChart;
async function renderSleepChart() {
  const list = await api("/api/sessions");
  const sessions = [...list].reverse(); // left→right = old→new

  const labels = [];
  const bedMinsAdj = [];  // 就寝（前日なら負値）
  const wakeMins = [];    // 起床（当日 0..1440）
  const durHours = [];    // 睡眠時間[h]

  sessions.forEach((r) => {
    const start = new Date(r.start);
    const end   = new Date(r.end);
    const label = `${end.getMonth() + 1}/${end.getDate()}`;
    labels.push(label);

    const sM = toMins(start);
    const eM = toMins(end);
    // 日跨ぎ対策：就寝が起床より遅いなら前日扱いで 24h 引く
    const sAdj = (sM > eM) ? (sM - 1440) : sM;

    bedMinsAdj.push(sAdj);
    wakeMins.push(eM);

    const dur = (end - start) / 3600000; // ms → h
    durHours.push(Math.max(0, Math.round(dur * 10) / 10)); // 0.1刻み
  });

  const canvas = document.getElementById("sleepChart");
  if (!canvas) return; // chart無しページに備える
  const ctx = canvas.getContext("2d");
  if (sleepChart) sleepChart.destroy();

  sleepChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Bedtime",
          data: bedMinsAdj,
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 2,
        },
        {
          label: "Wake-up",
          data: wakeMins,
          tension: 0.35,
          pointRadius: 3,
          borderWidth: 2,
        },
        {
          type: "bar",
          label: "Sleep duration (h)",
          data: durHours,
          yAxisID: "y2",
          borderWidth: 0,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // 親 .chart-box の高さにフィット
      scales: {
        y: {
          title: { display: true, text: "Clock time (HH:MM)" },
          min: -360,           // 前日18:00まで可視（必要なら調整）
          max: 24 * 60,
          ticks: {
            stepSize: 60,
            callback: (v) => mmToHHMM(v),
          },
          grid: { drawOnChartArea: true }
        },
        y2: {
          title: { display: true, text: "Duration (hours)" },
          position: "right",
          min: 0,
          suggestedMax: 10,
          grid: { drawOnChartArea: false }
        },
        x: {
          title: { display: true, text: "Date" }
        }
      },
      plugins: {
        legend: { display: true },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex === 0) return `Bedtime: ${mmToHHMM(ctx.parsed.y)}`;
              if (ctx.datasetIndex === 1) return `Wake-up: ${mmToHHMM(ctx.parsed.y)}`;
              if (ctx.datasetIndex === 2) return `Duration: ${ctx.parsed.y} h`;
              return ctx.formattedValue;
            }
          }
        }
      },
      elements: { line: { borderWidth: 2 } }
    }
  });
}

// ---------- Good Things (mine + others) ----------
function renderMine(targetUl, emptyEl, rows) {
  targetUl.innerHTML = "";
  if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");

  rows.forEach((r) => {
    const li = document.createElement("li");
    const items = (r.positives && r.positives.length)
      ? r.positives.join("<br>")  // ← 先頭記号は付けない（ULのマーカーと二重防止）
      : "<i>(empty)</i>";
    li.innerHTML = items;
    targetUl.appendChild(li);
  });
}

// 他人: {text, genre} でも {positives:[...]} でも string でも描ける耐性版
function renderGoodThingsList(targetUl, emptyEl, items) {
  targetUl.innerHTML = "";
  if (!items || !items.length) { emptyEl.classList.remove("hidden"); return; }
  emptyEl.classList.add("hidden");

  items.forEach((item) => {
    let text, genre;
    if (item && typeof item === "object") {
      text  = item.text ?? (Array.isArray(item.positives) ? item.positives[0] : "");
      genre = item.genre;
    } else {
      text = String(item || "");
    }

    if (!text) return;

    const li = document.createElement("li");
    const txt = document.createElement("span");
    txt.textContent = text;
    li.appendChild(txt);

    if (genre) {
      const tag = document.createElement("span");
      tag.textContent = ` ${genre}`;
      tag.style.marginLeft = "8px";
      tag.style.fontSize = "12px";
      tag.style.opacity = "0.8";
      tag.style.padding = "2px 6px";
      tag.style.borderRadius = "8px";
      tag.style.background = "rgba(255,255,255,0.12)";
      li.appendChild(tag);
    }

    targetUl.appendChild(li);
  });
}

async function refreshGoodThings() {
  const data = await api(`/api/good-things?flatten=true&others_limit=5`);

  // 自分：最新3件
  const mineLast3 = (data.mine || []).slice(-3).reverse();
  const mineUL = document.getElementById("mine");
  const mineEmpty = document.getElementById("mine-empty");
  if (mineUL && mineEmpty) {
    renderMine(mineUL, mineEmpty, mineLast3);
  }

  // 他人：{text, genre} を優先。無ければテキストのみから生成。
  const othersSrc = data.others_flat_objects
    ? data.others_flat_objects
    : (data.others_flat || []).map(t => ({ text: t }));

  const othersUL = document.getElementById("others");
  const othersEmpty = document.getElementById("others-empty");
  if (othersUL && othersEmpty) {
    renderGoodThingsList(othersUL, othersEmpty, othersSrc);
  }
}

// ---------- boot ----------
(async () => {
  try {
    await refreshMe();
    await renderSleepChart();   // グラフがあるページのみ描画される
    await refreshGoodThings();
  } catch (e) {
    console.error(e);
    // 必要なら alert してもOK
  }
})();

// reload ボタンが存在する場合のみハンドラ付与
const reloadBtn = document.getElementById("reload-others");
if (reloadBtn) reloadBtn.addEventListener("click", () => refreshGoodThings());

// ---------- hero height (background1) ----------
(function tuneHeroHeight() {
  const phone = document.querySelector(".phone");
  const main = document.querySelector("main");
  if (!phone || !main) return;

  const img = new Image();
  img.src = "assets/background1.png";
  img.onload = () => {
    const w = img.naturalWidth || 1080;
    const h = img.naturalHeight || 1920;
    const ratio = h / w;

    const phoneWidth = phone.getBoundingClientRect().width;
    const heroH = Math.round(phoneWidth * ratio);

    main.style.setProperty("--hero-h", heroH + "px");
  };
})();
