-- 1. Таблица клиентов
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(120) NOT NULL,
    tax_id VARCHAR(20) UNIQUE NOT NULL,
    phone VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Таблица страховых полисов (внешний ключ на clients + срок действия)
CREATE TABLE policies (
    id SERIAL PRIMARY KEY,
    client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    policy_type VARCHAR(30) NOT NULL,
    base_premium NUMERIC(10, 2) NOT NULL,
    risk_multiplier NUMERIC(4, 2) DEFAULT 1.00,
    status VARCHAR(30) DEFAULT 'PENDING_SCORING',
    expires_at DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Таблица страховых случаев / убытков (внешний ключ на policies)
CREATE TABLE claims (
    id SERIAL PRIMARY KEY,
    policy_id INT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    requested_amount NUMERIC(10, 2) NOT NULL,
    approved_payout NUMERIC(10, 2) DEFAULT 0.00,
    status VARCHAR(30) DEFAULT 'UNDER_REVIEW',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Стартовые данные
INSERT INTO clients (full_name, tax_id, phone) VALUES
('Иванов Петр Сергеевич', '770123456789', '+7 (999) 111-22-33'),
('Смирнова Анна Викторовна', '770987654321', '+7 (999) 444-55-66');

INSERT INTO policies (client_id, policy_type, base_premium, risk_multiplier, status, expires_at) VALUES
(1, 'КАСКО\ОСАГО', 45000.00, 1.40, 'APPROVED', '2027-06-15'),     -- Актуальный полис
(1, 'НЕДВИЖИМОСТЬ', 30000.00, 1.10, 'APPROVED', '2025-10-01'), -- Истёкший полис
(2, 'ДМС', 80000.00, 2.85, 'REJECTED', '2027-01-20');

INSERT INTO claims (policy_id, description, requested_amount, approved_payout, status) VALUES
(1, 'ДТП на парковке, помято крыло', 65000.00, 18500.00, 'PAID_PARTIAL'),
(2, 'Затопили соседи сверху', 120000.00, 0.00, 'DENIED_CLAUSE');


-- 4. Таблица сотрудников страховой компании
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(40) NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
