import os
import json
import asyncio
import asyncpg
import aio_pika

DB_URL = os.getenv("DATABASE_URL")
AMQP_URL = os.getenv("AMQP_URL")
QUEUE_NAME = "underwriting_tasks"

# Базовые коэффициенты по умолчанию в зависимости от опасности полиса
BASE_RISK = {
    "КАСКО/ОСАГО": 1.20,       # Бьются часто
    "ДМС": 1.10,     # Болеют стабильно
    "ИММУЩЕСТВО": 1.05,   # Горят редко
    "ЖИЗНЬ": 1.00        # Разовое событие
}

async def calculate_policy_risk(conn: asyncpg.Connection, policy_id: int):
    # 1. Получаем инфу о текущем полисе и его владельце
    policy = await conn.fetchrow(
        "SELECT client_id, policy_type FROM policies WHERE id = $1",
        policy_id
    )
    if not policy:
        return

    client_id = policy["client_id"]
    ptype = policy["policy_type"]
    base_k = BASE_RISK.get(ptype, 1.10)

    # 2. Агрегируем реальную историю убытков этого клиента по всем его полисам
    history = await conn.fetchrow("""
        SELECT
            COUNT(cl.id) AS total_claims,
            COALESCE(SUM(cl.approved_payout), 0) AS total_payouts
        FROM claims cl
        JOIN policies p ON cl.policy_id = p.id
        WHERE p.client_id = $1 AND cl.approved_payout > 0
    """, client_id)

    past_claims = history["total_claims"]
    total_payouts = float(history["total_payouts"])

    # 3. Актуарная формула Bonus-Malus:
    # За каждый предыдущий факт выплаты накидываем +0.45 к множителю
    # За каждые 50 000 руб выплат накидываем ещё +0.1
    payout_penalty = (total_payouts // 50000) * 0.10
    claims_penalty = past_claims * 0.45

    if past_claims == 0:
        # Клиент чист — даём скидку за безаварийность
        final_multiplier = round(base_k * 0.9, 2)
    else:
        # Клиент убыточен — закручиваем гайки
        final_multiplier = round(base_k + claims_penalty + payout_penalty, 2)

    # Порог отказа страховой: если множитель улетает выше 2.30 — клиент токсичен
    if final_multiplier > 2.30:
        status = "REJECTED"
    else:
        status = "APPROVED"

    print(f"[Underwriter] Полис #{policy_id} (Клиент #{client_id}): "
          f"Выплат в истории: {past_claims} (на сумму {total_payouts:.2f} ₽) -> "
          f"Коэф: x{final_multiplier}, Статус: {status}")

    await conn.execute(
        "UPDATE policies SET risk_multiplier = $1, status = $2 WHERE id = $3",
        final_multiplier, status, policy_id
    )

async def evaluate_claim(conn: asyncpg.Connection, task: dict):
    claim_id = task["claim_id"]
    requested = task["requested"]

    # Проверяем, сколько этот полис уже выкачал денег
    claim_info = await conn.fetchrow(
        "SELECT policy_id FROM claims WHERE id = $1", claim_id
    )
    policy_payouts = await conn.fetchval(
        "SELECT COALESCE(SUM(approved_payout), 0) FROM claims WHERE policy_id = $1 AND id != $2",
        claim_info["policy_id"], claim_id
    )

    # Если по этому полису уже платили — юристы компании начинают отказывать агрессивнее
    if policy_payouts > 0:
        # Повторный убыток — 70% шанс отказа
        deny_threshold = 0.70
    else:
        deny_threshold = 0.40

    import random
    if random.random() < deny_threshold:
        status = "DENIED_CLAUSE"
        payout = 0.0
    else:
        status = "PAID_PARTIAL"
        # Режем выплату до 30-60% от запрошенного
        payout = round(requested * random.uniform(0.3, 0.6), 2)

    await conn.execute(
        "UPDATE claims SET approved_payout = $1, status = $2 WHERE id = $3",
        payout, status, claim_id
    )
    print(f"[Legal] Убыток #{claim_id}: Запрошено {requested} ₽ -> {status} (Выплачено: {payout} ₽)")

async def main():
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=4)
    connection = await aio_pika.connect_robust(AMQP_URL)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=1)
    queue = await channel.declare_queue(QUEUE_NAME, durable=True)

    print("[Worker] Актуарный скоринг с учётом истории выплат запущен...")

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                task = json.loads(message.body.decode())
                task_type = task.get("task_type")
                await asyncio.sleep(2)  # Эмуляция глубокого скоринга

                async with pool.acquire() as conn:
                    if task_type == "SCORE_POLICY":
                        await calculate_policy_risk(conn, task["policy_id"])
                    elif task_type == "EVALUATE_CLAIM":
                        await evaluate_claim(conn, task)

if __name__ == "__main__":
    asyncio.run(main())
