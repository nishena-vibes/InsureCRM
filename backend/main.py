import os
import json
import hmac
import hashlib
import base64
import time
from datetime import date
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import asyncpg
import aio_pika

DB_URL = os.getenv("DATABASE_URL")
AMQP_URL = os.getenv("AMQP_URL")
SECRET_KEY = os.getenv("SECRET_KEY", "super-cynical-insurance-secret-key-2026")
QUEUE_NAME = "underwriting_tasks"

pool: asyncpg.Pool = None
amqp_conn: aio_pika.RobustConnection = None
amqp_channel: aio_pika.Channel = None
security = HTTPBearer()

# --- КРИПТОГРАФИЯ И ТОКЕНЫ (Без внешних библиотек) ---

def hash_password(password: str, salt: str = "insure_salt") -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000)
    return f"{salt}${dk.hex()}"

def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, _ = stored_hash.split("$", 1)
        return hmac.compare_digest(hash_password(password, salt), stored_hash)
    except ValueError:
        return False

def create_token(data: dict, ttl: int = 86400) -> str:
    payload = {**data, "exp": int(time.time()) + ttl}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(SECRET_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"

def decode_token(token: str) -> dict:
    try:
        raw, sig = token.split(".", 1)
        expected_sig = hmac.new(SECRET_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            raise ValueError("Invalid signature")
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()).decode())
        if payload.get("exp", 0) < time.time():
            raise ValueError("Token expired")
        return payload
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Сессия истекла или недействительна. Войдите заново."
        )

async def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    return decode_token(creds.credentials)

async def init_employees_table(db_pool: asyncpg.Pool):
    async with db_pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                full_name VARCHAR(120) NOT NULL,
                role VARCHAR(40) NOT NULL,
                password_hash VARCHAR(128) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        count = await conn.fetchval("SELECT COUNT(*) FROM employees")
        if count == 0:
            await conn.execute(
                """
                INSERT INTO employees (username, full_name, role, password_hash) VALUES
                ($1, $2, $3, $4),
                ($5, $6, $7, $8)
                """,
                "admin", "Шеляков Н.С.", "ADMIN", hash_password("admin123"),
                "agent", "Гуров М.А.", "AGENT", hash_password("agent123")
            )

@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool, amqp_conn, amqp_channel
    pool = await asyncpg.create_pool(DB_URL, min_size=2, max_size=10)
    await init_employees_table(pool)
    amqp_conn = await aio_pika.connect_robust(AMQP_URL)
    amqp_channel = await amqp_conn.channel()
    await amqp_channel.declare_queue(QUEUE_NAME, durable=True)
    yield
    await amqp_conn.close()
    await pool.close()

app = FastAPI(lifespan=lifespan)

async def publish_task(payload: dict):
    msg = aio_pika.Message(
        body=json.dumps(payload).encode(),
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT
    )
    await amqp_channel.default_exchange.publish(msg, routing_key=QUEUE_NAME)

# --- СХЕМЫ ДАННЫХ ---

class LoginRequest(BaseModel):
    username: str
    password: str

class ClientCreate(BaseModel):
    full_name: str
    tax_id: str
    phone: str

class PolicyCreate(BaseModel):
    client_id: int
    policy_type: str
    base_premium: float
    expires_at: date

class ClaimCreate(BaseModel):
    policy_id: int
    description: str
    requested_amount: float

# --- ЭНДПОИНТЫ АВТОРИЗАЦИИ ---

@app.post("/api/login")
async def login(data: LoginRequest):
    async with pool.acquire() as conn:
        emp = await conn.fetchrow(
            "SELECT id, username, full_name, role, password_hash FROM employees WHERE username = $1",
            data.username.strip()
        )
        if not emp or not verify_password(data.password, emp["password_hash"]):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль сотрудника")

        user_info = {
            "id": emp["id"],
            "username": emp["username"],
            "full_name": emp["full_name"],
            "role": emp["role"]
        }
        return {"token": create_token(user_info), "user": user_info}

# --- ЗАЩИЩЁННЫЕ ЭНДПОИНТЫ CRM ---

@app.get("/api/dashboard")
async def get_dashboard(user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        clients = await conn.fetch("SELECT * FROM clients ORDER BY id DESC")
        policies = await conn.fetch("""
            SELECT p.*, c.full_name as client_name,
                   (p.expires_at < CURRENT_DATE) AS is_expired
            FROM policies p
            JOIN clients c ON p.client_id = c.id
            ORDER BY p.id DESC
        """)
        claims = await conn.fetch("""
            SELECT cl.*, p.policy_type, c.full_name as client_name
            FROM claims cl
            JOIN policies p ON cl.policy_id = p.id
            JOIN clients c ON p.client_id = c.id
            ORDER BY cl.id DESC
        """)
        return {
            "clients": [dict(r) for r in clients],
            "policies": [dict(r) for r in policies],
            "claims": [dict(r) for r in claims]
        }

@app.post("/api/clients", status_code=201)
async def create_client(data: ClientCreate, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "INSERT INTO clients (full_name, tax_id, phone) VALUES ($1, $2, $3) RETURNING *",
                data.full_name, data.tax_id, data.phone
            )
            return dict(row)
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=400, detail="Клиент с таким ИНН уже существует")

@app.delete("/api/clients/{client_id}")
async def delete_client(client_id: int, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM clients WHERE id = $1", client_id)
    return {"ok": True}

@app.post("/api/policies", status_code=201)
async def create_policy(data: PolicyCreate, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO policies (client_id, policy_type, base_premium, expires_at)
            VALUES ($1, $2, $3, $4) RETURNING *
            """,
            data.client_id, data.policy_type, data.base_premium, data.expires_at
        )
    await publish_task({"task_type": "SCORE_POLICY", "policy_id": row["id"]})
    return dict(row)

@app.post("/api/policies/{policy_id}/renew", status_code=200)
async def renew_policy(policy_id: int, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE policies
            SET expires_at = CURRENT_DATE + INTERVAL '1 year',
                status = 'PENDING_SCORING'
            WHERE id = $1
            RETURNING id, client_id, policy_type
            """,
            policy_id
        )
        if not row:
            raise HTTPException(status_code=404, detail="Полис не найден")

    await publish_task({"task_type": "SCORE_POLICY", "policy_id": row["id"]})
    return {"ok": True, "message": f"Полис #{row['id']} отправлен на переоценку"}

@app.delete("/api/policies/{policy_id}")
async def delete_policy(policy_id: int, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM policies WHERE id = $1", policy_id)
    return {"ok": True}

@app.post("/api/claims", status_code=201)
async def create_claim(data: ClaimCreate, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        policy = await conn.fetchrow(
            "SELECT status, (expires_at < CURRENT_DATE) AS is_expired FROM policies WHERE id = $1",
            data.policy_id
        )
        if not policy or policy["status"] != "APPROVED":
            raise HTTPException(status_code=400, detail="Убыток можно подать только по одобренному (APPROVED) полису")
        if policy["is_expired"]:
            raise HTTPException(status_code=400, detail="Отказ: срок действия этого полиса уже истёк")

        row = await conn.fetchrow(
            "INSERT INTO claims (policy_id, description, requested_amount) VALUES ($1, $2, $3) RETURNING *",
            data.policy_id, data.description, data.requested_amount
        )
    await publish_task({
        "task_type": "EVALUATE_CLAIM",
        "claim_id": row["id"],
        "requested": float(row["requested_amount"])
    })
    return dict(row)

@app.delete("/api/claims/{claim_id}")
async def delete_claim(claim_id: int, user: dict = Depends(get_current_user)):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM claims WHERE id = $1", claim_id)
    return {"ok": True}
