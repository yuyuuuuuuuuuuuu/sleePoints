from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: Optional[str] = None
    email: Optional[str] = None      # ← 追加
    points: float = 0.0

class SleepSession(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="user.id")
    start: datetime
    end: datetime
    credited_points: float
    created_at: datetime = Field(default_factory=datetime.utcnow)

# 既存の User, SleepSession はそのまま

class Product(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    image: Optional[str] = None  # 例: "/assets/moyashi.jpg"
    price: int                   # 正整数 (points)
    description: Optional[str] = ""

class RedeemOrder(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="user.id")
    product_id: int = Field(index=True, foreign_key="product.id")
    qty: int
    cost_points: int
    created_at: datetime = Field(default_factory=datetime.utcnow)
