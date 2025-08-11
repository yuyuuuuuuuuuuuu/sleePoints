import math, os, random, csv, io, time
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlmodel import select, SQLModel
from dotenv import load_dotenv
from datetime import datetime, timedelta
from dateutil import parser as dtparse
from .database import init_db, get_session, engine
from .models import User, SleepSession, Product, RedeemOrder
from .schemas import SessionOut, UserOut, ProductOut, RedeemIn, RedeemOut
import httpx

load_dotenv()

app = FastAPI(title="Sleepoints API", version="0.2.0")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

# ---- 設定 ----
N8N_WEBHOOK_URL = os.getenv("N8N_WEBHOOK_URL")
SHEET_CSV_URL   = os.getenv("SHEET_CSV_URL")   # Google Sheets CSV
INITIAL_POINTS  = 500.0

DEMO_USER_EMAIL = os.getenv("DEMO_USER_EMAIL", "").strip().lower()

# 追加
DEMO_USER_ID = os.getenv("DEMO_USER_ID", "").strip()
DEMO_FIRST_NAME = os.getenv("DEMO_FIRST_NAME", "").strip().lower()
DEMO_LAST_NAME  = os.getenv("DEMO_LAST_NAME", "").strip().lower()


# ---- シート読み取りのキャッシュ（秒）----
_SHEET_CACHE_TTL = 60
_sheet_cache = {"ts": 0.0, "rows": []}

@app.on_event("startup")
def on_startup():
    init_db()
    from sqlmodel import Session
    with Session(engine) as session:
        user = session.get(User, DEMO_USER_ID)
        if not user:
            user = User(id=DEMO_USER_ID, username="demo", points=INITIAL_POINTS)
            session.add(user)
            session.commit()

        # Seed: 睡眠セッションが無ければ過去10日ぶん投入
        has = session.exec(select(SleepSession).where(SleepSession.user_id==DEMO_USER_ID)).first()
        if not has:
            base = datetime.now().replace(hour=22, minute=30, second=0, microsecond=0)
            total_added = 0.0
            for i in range(10):
                # ランダムに 22:00〜1:00 開始、6〜8.5h 睡眠
                start = (base - timedelta(days=i)) + timedelta(minutes=random.randint(-60,120))
                hours = random.uniform(6.0, 8.5)
                end = start + timedelta(hours=hours)
                credited = math.floor(hours*10)/10
                rec = SleepSession(
                    user_id=DEMO_USER_ID, start=start, end=end, credited_points=credited
                )
                session.add(rec)
                total_added += credited
            user.points = round(INITIAL_POINTS + total_added, 1)
            session.add(user)
            session.commit()

# ---- 既存：ユーザー/履歴 ----
@app.get("/api/me", response_model=UserOut)
def get_me(session=Depends(get_session)):
    user = session.get(User, DEMO_USER_ID)
    assert user is not None
    return UserOut(id=user.id, username=user.username, points=round(user.points, 1))

@app.get("/api/sessions", response_model=list[SessionOut])
def list_sessions(session=Depends(get_session)):
    result = session.exec(
        select(SleepSession).where(SleepSession.user_id==DEMO_USER_ID).order_by(SleepSession.created_at.desc())
    ).all()
    return [SessionOut(**s.dict()) for s in result]

# ---- Google Sheets 読み取り ----
async def _fetch_sheet_rows():
    """CSVを取得して行dictの配列にして返す。キャッシュあり。新フォーマット対応。"""
    now = time.time()
    if _sheet_cache["rows"] and (now - _sheet_cache["ts"] < _SHEET_CACHE_TTL):
        return _sheet_cache["rows"]

    if not SHEET_CSV_URL:
        raise HTTPException(status_code=500, detail="SHEET_CSV_URL is not set")

    async with httpx.AsyncClient(timeout=10, follow_redirects=True,
                                 headers={"User-Agent": "Mozilla/5.0"}) as client:
        r = await client.get(SHEET_CSV_URL)
        r.raise_for_status()
        content = r.content

    # HTMLなら公開設定ミス
    if content.lstrip().startswith(b"<!DOCTYPE html") or b"<html" in content[:200].lower():
        raise HTTPException(status_code=502, detail="SHEET_CSV_URL returned HTML (not public CSV). Use 'Publish to the web' CSV URL.")

    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        # ヘッダ名の取り出し（多言語/大小文字に寛容に）
        def get(keys: list[str]) -> str:
            for k in keys:
                if k in row and row[k] is not None:
                    return str(row[k]).strip()
            # 大文字小文字を無視して探索
            lower_map = { (kk or "").strip().lower(): kk for kk in row.keys() }
            for k in keys:
                true_k = lower_map.get(k.lower())
                if true_k:
                    v = row.get(true_k, "")
                    return str(v).strip()
            return ""

        rid   = get(["ID"])
        fname = get(["First Name","first name","名","First"])
        lname = get(["Last Name","last name","姓","Last"])
        text_ = get(["回答文","Text","text","Answer","answer"])
        genre = get(["ジャンル","Genre","genre","Category","category"])

        if not text_:
            # 空行はスキップ
            continue

        rows.append({
            "id": rid,
            "first_name": fname,
            "last_name": lname,
            "name": (fname + " " + lname).strip(),
            "text": text_,
            "genre": genre or None,
            # 互換性のため
            "timestamp": "",                 # 以前のUIが参照しても落ちないよう空文字
            "positives": [text_],            # 以前の形に合わせる
            "email": "",                     # 今回は使わない
        })

    _sheet_cache["rows"] = rows
    _sheet_cache["ts"] = now
    return rows


@app.get("/api/good-things")
async def get_good_things(
    others_limit: int = Query(10, ge=1, le=200),
    include_raw: bool = False,
    flatten: bool = False,
):
    rows = await _fetch_sheet_rows()

    # 自分判定
    def is_mine(r: dict) -> bool:
        if DEMO_USER_ID and r.get("id") == DEMO_USER_ID:
            return True
        if DEMO_FIRST_NAME and DEMO_LAST_NAME:
            return (
                (r.get("first_name", "").strip().lower() == DEMO_FIRST_NAME) and
                (r.get("last_name", "").strip().lower() == DEMO_LAST_NAME)
            )
        if DEMO_USER_EMAIL:
            return r.get("email", "").strip().lower() == DEMO_USER_EMAIL
        return False

    mine_rows   = [r for r in rows if is_mine(r)]
    others_rows = [r for r in rows if not is_mine(r)]

    random.shuffle(others_rows)
    others = others_rows[:others_limit]

    def strip_row(r: dict) -> dict:
        base = {
            k: r.get(k) for k in ("timestamp", "email", "positives", "name", "genre", "id")
        }
        # Your “Good Things” 用にテキスト化（複数行の場合は配列のまま positives に）
        text_field = (r.get("text") or "").strip()
        if text_field:
            base["text"] = text_field
        if include_raw:
            base["raw"] = r
        return base

    out = {
        # mine にも genre を含める
        "mine":   [strip_row(r) for r in mine_rows],
        "others": [strip_row(r) for r in others],
        "total":  {"mine": len(mine_rows), "others": len(others_rows)},
    }

    if flatten:
        # 他人データからテキスト＋ジャンル抽出
        pool_objs: list[dict] = []
        for r in others_rows:
            genre = (r.get("genre") or "").strip() or None

            t = (r.get("text") or "").strip()
            if t:
                pool_objs.append({"text": t, "genre": genre})
                continue

            for t2 in (r.get("positives") or []):
                t2 = (t2 or "").strip()
                if t2:
                    pool_objs.append({"text": t2, "genre": genre})

        seen = set()
        dedup = []
        for obj in pool_objs:
            if obj["text"] in seen:
                continue
            seen.add(obj["text"])
            dedup.append(obj)

        random.shuffle(dedup)
        picked = dedup[:others_limit]

        out["others_flat"] = [o["text"] for o in picked]
        out["others_flat_objects"] = picked

    return out


@app.on_event("startup")
def on_startup():
    init_db()
    from sqlmodel import Session, select
    with Session(engine) as session:
        # Demo user
        user = session.get(User, DEMO_USER_ID)
        if not user:
            user = User(id=DEMO_USER_ID, username="demo", points=INITIAL_POINTS)
            session.add(user)
            session.commit()

        # Seed sleep sessions（既存と同じ）…省略…

        # ▼ Product をシード
        has_products = session.exec(select(Product)).first()
        if not has_products:
            session.add_all([
                Product(
                    name="online crane game 1 play", image="/assets/gacha.jpg",
                    price=10, description="Enjoy one chance to win a prize in an exciting online crane game."
                ),
                Product(
                    name="Donation to NPO", image="/assets/donation.png",
                    price=1, description="Contribute from 1 point to support an NPO working toward social and environmental causes."
                ),

                Product(
                    name="3.38$ Starbucks drink ticket", image="/assets/Starbucks.jpg",
                    price=500, description="Redeemable for a Starbucks beverage of your choice, up to $3.38 in value."
                ),
                Product(
                    name="1$ coke on drink tickets", image="/assets/drink.jpg",
                    price=160, description="A drink ticket redeemable via the Coke ON app for one beverage worth up to $1."
                ),
                Product(
                    name="Photo booth Tickets", image="/assets/photo.jpg",
                    price=500, description="Use this ticket to take fun and memorable pictures at a photo booth."
                ),
                Product(
                    name="1.35$ mister Donut Tickets", image="/assets/donut.jpg",
                    price=200, description="Redeem this ticket for delicious donuts at Mister Donut, worth up to $1.35."
                ),
                Product(
                    name="eco-friendly mechanical pencil", image="/assets/pencil.jpg",
                    price=150, description="A high-quality, eco-friendly mechanical pencil made from sustainable materials for smooth and precise writing."
                ),
                Product(
                    name="recycled paper notebook", image="/assets/notebook.jpg",
                    price=200, description="A durable notebook made from recycled paper, perfect for jotting down notes, ideas, and sketches while being kind to the environment."
                ),
                ])
            session.commit()

# --- Products API ---
@app.get("/api/products", response_model=list[ProductOut])
def list_products(session=Depends(get_session)):
    return session.exec(select(Product)).all()

@app.get("/api/products/{pid}", response_model=ProductOut)
def get_product(pid: int, session=Depends(get_session)):
    p = session.get(Product, pid)
    if not p:
        raise HTTPException(404, "product not found")
    return p

# --- Redeem API ---
@app.post("/api/redeem", response_model=RedeemOut)
def redeem(body: RedeemIn, session=Depends(get_session)):
    if body.qty <= 0:
        raise HTTPException(400, "qty must be positive")
    p = session.get(Product, body.product_id)
    if not p:
        raise HTTPException(404, "product not found")

    user = session.get(User, DEMO_USER_ID)
    cost = p.price * body.qty
    # 100 個上限（仕様）
    if body.qty > 100:
        raise HTTPException(400, "qty exceeds max limit (100)")
    # 残高チェック
    if user.points < cost:
        raise HTTPException(400, "insufficient points")

    user.points = round(user.points - cost, 1)  # 残は小数1位運用のまま
    order = RedeemOrder(user_id=user.id, product_id=p.id, qty=body.qty, cost_points=cost)
    session.add_all([user, order])
    session.commit()
    session.refresh(order)
    return RedeemOut(order_id=order.id, remaining_points=user.points)


# ---- フロント配信 ----
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")


