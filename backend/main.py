import os
import json
from datetime import date
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import asyncpg
import aio_pika

DB_URL = os.getenv("DATABASE_URL")
AMQP_URL = os.getenv("AMQP_URL")
QUEUE_NAME = "underwriting_tasks"

pool: asyncpg.Pool = None
amqp_conn: aio_pika.RobustConnection = None
amqp_channel: aio_pika.Channel = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool, amqp_conn, amqp_channel
    pool = await asyncpg.create_pool(DB_URL, min_size=2, max_size=10)
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

@app.get("/api/dashboard")
async def get_dashboard():
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
async def create_client(data: ClientCreate):
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
async def delete_client(client_id: int):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM clients WHERE id = $1", client_id)
    return {"ok": True}

@app.post("/api/policies", status_code=201)
async def create_policy(data: PolicyCreate):
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

@app.delete("/api/policies/{policy_id}")
async def delete_policy(policy_id: int):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM policies WHERE id = $1", policy_id)
    return {"ok": True}

@app.post("/api/claims", status_code=201)
async def create_claim(data: ClaimCreate):
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
async def delete_claim(claim_id: int):
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM claims WHERE id = $1", claim_id)
    return {"ok": True}

@app.post("/api/policies/{policy_id}/renew", status_code=200)
async def renew_policy(policy_id: int):
    async with pool.acquire() as conn:
        # Сдвигаем дату окончания ровно на 1 год вперед от сегодняшнего дня и сбрасываем статус на скоринг
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

    # Отправляем задачу на повторный скоринг в RabbitMQ
    await publish_task({"task_type": "SCORE_POLICY", "policy_id": row["id"]})
    return {"ok": True, "message": f"Полис #{row['id']} отправлен на переоценку"}
