from pydantic import BaseModel
from datetime import datetime

# リクエスト
class SessionCreate(BaseModel):
    start: datetime
    end: datetime

# レスポンス
class UserOut(BaseModel):
    id: int
    username: str | None
    points: float

class SessionOut(BaseModel):
    id: int
    start: datetime
    end: datetime
    credited_points: float
    created_at: datetime

class ProductOut(BaseModel):
    id: int
    name: str
    image: str | None
    price: int
    description: str | None

class RedeemIn(BaseModel):
    product_id: int
    qty: int

class RedeemOut(BaseModel):
    order_id: int
    remaining_points: float
