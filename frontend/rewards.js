// rewards.js
// --- special caps per product ---
const SPECIAL = {
  NPO: "Donation to NPO",
  CRANE: "online crane game 1 play",
};

function showVideoOverlay(src, poster) {
  // 既存が残っていたら一旦消す（多重防止）
  const old = document.querySelector(".video-overlay");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.className = "video-overlay";
  overlay.setAttribute("aria-hidden", "false");

  const box = document.createElement("div");
  box.className = "video-box";

  const vid = document.createElement("video");
  vid.src = src;
  if (poster) vid.poster = poster;

  // モバイルでの自動再生に必須（ユーザー操作直後でも安全策）
  vid.muted = true;         // 自動再生ポリシー対策（音あり自動再生はブロックされやすい）
  vid.playsInline = true;   // iOS Safari対策
  vid.autoplay = true;
  vid.controls = false;

  box.appendChild(vid);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // 背景スクロールを止める（既に modal-open でも問題なし）
  document.body.classList.add("modal-open");

  // 再生終了で自動クローズ（×ボタンは要らない仕様）
  const cleanup = () => {
    overlay.remove();
    // まだモーダルが開いているかもしれないので modal-open は残す
    // （モーダルを閉じた時に remove される）
  };
  vid.addEventListener("ended", cleanup);

  // 念のための保険（動画イベント拾えなかった場合など）
  const fallbackTimer = setTimeout(() => {
    if (document.body.contains(overlay)) cleanup();
  }, 70_000); // 70秒で自動クローズ
  overlay.addEventListener("remove", () => clearTimeout(fallbackTimer));

  // すぐ再生（iOS対策：購入ボタン押下＝ユーザー操作直後なので基本OK）
  vid.play().catch(() => {
    // もしブロックされたら、タップで開始できるようにする
    overlay.addEventListener("click", () => vid.play().catch(()=>{}), { once: true });
  });
}


function computeMaxQty(product, points) {
  const byBalance = Math.floor(points / product.price); // 残高で買える上限
  if (product.name === SPECIAL.NPO) {
    // 100個制限なし：残高ぶんまで
    return Math.max(0, byBalance);
  }
  if (product.name === SPECIAL.CRANE) {
    // 常に1（ただし残高不足なら0）
    return Math.min(1, Math.max(0, byBalance));
  }
  // 既定：100個上限
  return Math.min(100, Math.max(0, byBalance));
}

// 簡易API呼び出しヘルパー
async function api(url, opt = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opt
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return await res.json();
}

// 商品画像のURLを決定
function imgSrc(p) {
  if (!p || !p.image) return "assets/placeholder.png";
  const src = p.image.trim();
  if (/^https?:\/\//i.test(src)) return src; // 外部URL
  return src.replace(/^\//, ""); // ローカルassets
}

// DOMショートカット
function $(id) { return document.getElementById(id); }

// グローバル状態
let ME = null;
let PRODUCTS = [];
let SELECTED = null;

// 初期化
async function load() {
  // ユーザー情報
  ME = await api("/api/me");
  $("points").textContent = `${ME.points.toFixed(1)} pts`;

  // 商品一覧
  PRODUCTS = await api("/api/products");
  const cat = $("catalog");
  cat.innerHTML = "";
  PRODUCTS.forEach(p => {
    const card = document.createElement("div");
    card.className = "prod";
    card.innerHTML = `
      <img src="${imgSrc(p)}" alt="">
      <div class="meta">
        <div class="name">${p.name}</div>
        <div class="price">${p.price} pts</div>
      </div>`;
    card.addEventListener("click", () => openModal(p));
    cat.appendChild(card);
  });

  // モーダルのイベント
  $("modal-overlay").addEventListener("click", closeModal);
  $("modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  $("m-slider").addEventListener("input", () => {
    $("m-qty").textContent = $("m-slider").value;
    $("m-buy").disabled = (parseInt($("m-slider").value || "0", 10) <= 0);
  });

  $("m-buy").addEventListener("click", doBuy);
}

// モーダルを開く
function openModal(p){
  SELECTED = p;

  $("modal-title").textContent = p.name;
  $("m-img").src = imgSrc(p);
  $("m-desc").textContent = p.description || "";
  $("m-price").textContent = p.price;
  $("m-qty").textContent = "0";

  // ▼ここを差し替え
  const max = computeMaxQty(p, ME.points);

  const s = $("m-slider");
  s.min = "0"; s.max = String(max); s.value = "0";
  $("m-buy").disabled = (max === 0);

  // ヒントも商品に応じて表示
  let hint = (max === 0) ? "Not enough points."
           : `You can redeem up to ${max}.`;
  if (p.name === SPECIAL.NPO) hint += " (No 100-piece cap for donations.)";
  if (p.name === SPECIAL.CRANE) hint += " (Limited to 1 play per order.)";
  $("m-hint").textContent = hint;

  $("modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
}

// モーダルを閉じる
function closeModal() {
  $("modal").classList.add("hidden");
  document.body.classList.remove("modal-open");
  SELECTED = null;
}

// 購入処理
async function doBuy(){
  if (!SELECTED) return;
  const qty = parseInt($("m-slider").value||"0",10);
  if (qty<=0) return;
  const total = SELECTED.price * qty;

  // ★ 確認ポップアップを削除
  const out = await api("/api/redeem", {
    method: "POST",
    body: JSON.stringify({ product_id: SELECTED.id, qty })
  });

  ME.points = out.remaining_points;
  $("points").textContent = `${ME.points.toFixed(1)} pts`;

  // クレーンゲームだけ動画再生
  if (SELECTED.name === SPECIAL.CRANE) {
    showVideoOverlay("assets/gacha.mp4", "assets/gacha.jpg");
  } else {
    alert(`Redeemed! Remaining: ${ME.points.toFixed(1)} pts`);
  }

  // 上限を再計算（モーダルを開いたまま更新）
  openModal(SELECTED);
}




// 読み込み開始
document.addEventListener("DOMContentLoaded", () => {
  load().catch(err => alert("Load error: " + err.message));
});
