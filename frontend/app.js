let state = {
    clients: [],
    policies: [],
    claims: []
};

let authToken = localStorage.getItem('crm_token') || null;
let currentUser = JSON.parse(localStorage.getItem('crm_user') || 'null');
let syncInterval = null;

let lastClientsSignature = "";
let lastApprovedSignature = "";

const POLICY_TYPE_LABELS = {
    "AUTO": "КАСКО / ОСАГО",
    "PROPERTY": "Недвижимость",
    "HEALTH": "ДМС",
    "LIFE": "Жизнь"
};

const STATUS_LABELS = {
    "APPROVED": "Одобрен",
    "PENDING_SCORING": "В очереди",
    "REJECTED_HIGH_RISK": "Отказ (риск)",
    "REJECTED": "Отказ",
    "PAID_PARTIAL": "Частичная выплата",
    "DENIED_CLAUSE": "Отказ",
    "UNDER_REVIEW": "На рассмотрении"
};

const fmtMoney = (val) => Number(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

function setDefaultExpiryDate() {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    document.getElementById('p_expires').value = nextYear.toISOString().split('T')[0];
}

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = isError ? '#b91c1c' : '#1e293b';
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
}

// Единая обёртка для всех запросов к API с токеном сотрудника
async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        logout("Сессия истекла, войдите снова");
        throw new Error("Unauthorized");
    }
    return res;
}

function updateAuthUI() {
    const loginOverlay = document.getElementById('loginOverlay');
    const appContainer = document.getElementById('appContainer');
    const userBar = document.getElementById('userBar');
    const employeeName = document.getElementById('employeeName');

    if (authToken && currentUser) {
        loginOverlay.classList.add('hidden');
        appContainer.classList.remove('hidden');
        userBar.classList.remove('hidden');
        employeeName.textContent = currentUser.full_name;
        fetchDashboard();
        if (!syncInterval) {
            syncInterval = setInterval(fetchDashboard, 2000);
        }
    } else {
        loginOverlay.classList.remove('hidden');
        appContainer.classList.add('hidden');
        userBar.classList.add('hidden');
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }
}

function logout(msg = "Вы вышли из системы") {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_user');
    updateAuthUI();
    showToast(msg);
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUser').value;
    const password = document.getElementById('loginPass').value;

    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
        const err = await res.json();
        showToast(err.detail || 'Ошибка входа', true);
        return;
    }

    const data = await res.json();
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('crm_token', authToken);
    localStorage.setItem('crm_user', JSON.stringify(currentUser));
    e.target.reset();
    showToast(`Добро пожаловать, ${currentUser.full_name}`);
    updateAuthUI();
});

document.getElementById('logoutBtn').addEventListener('click', () => logout());

async function fetchDashboard() {
    if (!authToken) return;
    try {
        const res = await apiFetch('/api/dashboard');
        if (!res.ok) return;
        state = await res.json();
        renderAll();
    } catch (e) {
        console.error("Ошибка синхронизации:", e);
    }
}

function renderAll() {
    renderStats();
    renderClients();
    renderPolicies();
    renderClaims();
    updateSelects();
}

function renderStats() {
    const approvedPolicies = state.policies.filter(p => p.status === 'APPROVED');
    const activeValidPolicies = approvedPolicies.filter(p => !p.is_expired);
    const revenue = approvedPolicies.reduce((acc, p) => acc + (p.base_premium * p.risk_multiplier), 0);
    const payouts = state.claims.reduce((acc, c) => acc + Number(c.approved_payout), 0);
    const profit = revenue - payouts;

    document.getElementById('statClients').textContent = state.clients.length;
    document.getElementById('statPolicies').textContent = `${activeValidPolicies.length} / ${state.policies.length}`;
    document.getElementById('statRevenue').textContent = fmtMoney(revenue);
    document.getElementById('statPayouts').textContent = fmtMoney(payouts);

    const profitEl = document.getElementById('statProfit');
    profitEl.textContent = fmtMoney(profit);
    profitEl.className = 'stat-value ' + (profit >= 0 ? 'text-success' : 'text-danger');
}

function renderClients() {
    const query = document.getElementById('searchClient').value.toLowerCase().trim();
    const filtered = state.clients.filter(c =>
        c.full_name.toLowerCase().includes(query) || c.tax_id.includes(query)
    );

    const policyCounts = {};
    state.policies.forEach(p => { policyCounts[p.client_id] = (policyCounts[p.client_id] || 0) + 1; });

    document.getElementById('clientsBody').innerHTML = filtered.map(c => `
        <tr>
            <td>#${c.id}</td>
            <td><strong>${c.full_name}</strong></td>
            <td>${c.tax_id}</td>
            <td>${c.phone}</td>
            <td>${policyCounts[c.id] || 0} шт.</td>
            <td class="actions-cell">
                <button class="btn-del" title="Удалить клиента" onclick="deleteItem('/api/clients/${c.id}', 'Клиент и связанные полисы удалены')">X</button>
            </td>
        </tr>
    `).join('');
}

function renderPolicies() {
    const statusFilter = document.getElementById('filterPolicyStatus').value;
    const validityFilter = document.getElementById('filterPolicyValidity').value;

    const filtered = state.policies.filter(p => {
        const matchStatus = (statusFilter === 'ALL' || p.status === statusFilter);
        const matchValidity = (
            validityFilter === 'ALL' ||
            (validityFilter === 'VALID' && !p.is_expired) ||
            (validityFilter === 'EXPIRED' && p.is_expired)
        );
        return matchStatus && matchValidity;
    });

    document.getElementById('policiesBody').innerHTML = filtered.map(p => {
        const finalPrice = p.base_premium * p.risk_multiplier;
        const validityBadge = p.is_expired
            ? `<span class="badge EXPIRED_TAG">ИСТЁК</span>`
            : `<span class="badge VALID_TAG">АКТИВЕН</span>`;

        const renewBtn = p.is_expired
            ? `<button class="btn-renew" onclick="renewPolicy(${p.id})">Продлить</button>`
            : '';

        const typeLabel = POLICY_TYPE_LABELS[p.policy_type] || p.policy_type;
        const statusLabel = STATUS_LABELS[p.status] || p.status;

        return `
            <tr class="${p.is_expired ? 'row-expired' : ''}">
                <td>#${p.id}</td>
                <td>${p.client_name} <small>(ID: ${p.client_id})</small></td>
                <td><strong>${typeLabel}</strong></td>
                <td>${fmtMoney(p.base_premium)}</td>
                <td>x${p.risk_multiplier}</td>
                <td><strong>${fmtMoney(finalPrice)}</strong></td>
                <td>${p.expires_at} ${validityBadge}</td>
                <td><span class="badge ${p.status}">${statusLabel}</span></td>
                <td class="actions-cell">
                    ${renewBtn}
                    <button class="btn-del" title="Удалить полис" onclick="deleteItem('/api/policies/${p.id}', 'Полис удалён')">X</button>
                </td>
            </tr>
        `;
    }).join('');
}

async function renewPolicy(id) {
    const res = await apiFetch(`/api/policies/${id}/renew`, { method: 'POST' });
    if (!res.ok) {
        const err = await res.json();
        showToast(err.detail || 'Ошибка продления', true);
    } else {
        showToast('Полис продлён и отправлен на пересчёт в RabbitMQ');
        fetchDashboard();
    }
}

function renderClaims() {
    const statusFilter = document.getElementById('filterClaimStatus').value;
    const filtered = state.claims.filter(c => statusFilter === 'ALL' || c.status === statusFilter);

    document.getElementById('claimsBody').innerHTML = filtered.map(cl => {
        const saved = cl.requested_amount - cl.approved_payout;
        const typeLabel = POLICY_TYPE_LABELS[cl.policy_type] || cl.policy_type;
        const statusLabel = STATUS_LABELS[cl.status] || cl.status;

        return `
            <tr>
                <td>#${cl.id}</td>
                <td>Полис #${cl.policy_id} (${typeLabel} &bull; ${cl.client_name})</td>
                <td>${cl.description}</td>
                <td>${fmtMoney(cl.requested_amount)}</td>
                <td><strong>${fmtMoney(cl.approved_payout)}</strong></td>
                <td class="text-success">+${fmtMoney(saved)}</td>
                <td><span class="badge ${cl.status}">${statusLabel}</span></td>
                <td class="actions-cell">
                    <button class="btn-del" title="Удалить выплату" onclick="deleteItem('/api/claims/${cl.id}', 'Запись об убытке удалена')">X</button>
                </td>
            </tr>
        `;
    }).join('');
}

function updateSelects() {
    const cSig = state.clients.map(c => c.id).join(',');
    if (cSig !== lastClientsSignature) {
        lastClientsSignature = cSig;
        document.getElementById('p_client').innerHTML = state.clients.map(c =>
            `<option value="${c.id}">${c.full_name} (ИНН: ${c.tax_id})</option>`
        ).join('');
    }

    const approvedValid = state.policies.filter(p => p.status === 'APPROVED' && !p.is_expired);
    const aSig = approvedValid.map(p => `${p.id}_${p.is_expired}`).join(',');
    if (aSig !== lastApprovedSignature) {
        lastApprovedSignature = aSig;
        document.getElementById('cl_policy').innerHTML = approvedValid.length
            ? approvedValid.map(p => {
                const typeLabel = POLICY_TYPE_LABELS[p.policy_type] || p.policy_type;
                return `<option value="${p.id}">Полис #${p.id} [${typeLabel}] — ${p.client_name} (до ${p.expires_at})</option>`;
              }).join('')
            : `<option value="" disabled selected>Нет актуальных одобренных полисов</option>`;
    }
}

async function postData(url, payload, form, successMsg) {
    const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const err = await res.json();
        showToast(err.detail || 'Ошибка операции', true);
    } else {
        form.reset();
        if (form.id === 'policyForm') setDefaultExpiryDate();
        showToast(successMsg);
        fetchDashboard();
    }
}

async function deleteItem(url, msg) {
    await apiFetch(url, { method: 'DELETE' });
    showToast(msg);
    fetchDashboard();
}

document.getElementById('clientForm').addEventListener('submit', e => {
    e.preventDefault();
    postData('/api/clients', {
        full_name: document.getElementById('c_name').value,
        tax_id: document.getElementById('c_tax').value,
        phone: document.getElementById('c_phone').value
    }, e.target, 'Клиент добавлен в базу');
});

document.getElementById('policyForm').addEventListener('submit', e => {
    e.preventDefault();
    postData('/api/policies', {
        client_id: parseInt(document.getElementById('p_client').value),
        policy_type: document.getElementById('p_type').value,
        base_premium: parseFloat(document.getElementById('p_base').value),
        expires_at: document.getElementById('p_expires').value
    }, e.target, 'Полис отправлен на скоринг в RabbitMQ');
});

document.getElementById('claimForm').addEventListener('submit', e => {
    e.preventDefault();
    postData('/api/claims', {
        policy_id: parseInt(document.getElementById('cl_policy').value),
        description: document.getElementById('cl_desc').value,
        requested_amount: parseFloat(document.getElementById('cl_req').value)
    }, e.target, 'Убыток передан юристам через RabbitMQ');
});

document.getElementById('searchClient').addEventListener('input', renderClients);
document.getElementById('filterPolicyStatus').addEventListener('change', renderPolicies);
document.getElementById('filterPolicyValidity').addEventListener('change', renderPolicies);
document.getElementById('filterClaimStatus').addEventListener('change', renderClaims);

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tab;
        const map = {
            'tab-clients': 'sec-clients',
            'tab-policies': 'sec-policies',
            'tab-claims': 'sec-claims'
        };
        document.querySelectorAll('.tab-section').forEach(sec => {
            sec.classList.toggle('hidden', target !== 'tab-all' && sec.id !== map[target]);
        });
    });
});

setDefaultExpiryDate();
updateAuthUI();
