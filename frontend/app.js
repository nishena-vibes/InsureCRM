let state = {
    clients: [],
    policies: [],
    claims: []
};

let lastClientsSignature = "";
let lastApprovedSignature = "";

const fmtMoney = (val) => Number(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

// По умолчанию ставим срок действия полиса +1 год от сегодня
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

async function fetchDashboard() {
    try {
        const res = await fetch('/api/dashboard');
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
            <td><button class="btn-del" onclick="deleteItem('/api/clients/${c.id}', 'Клиент и связанные полисы удалены')">X</button></td>
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

        // Для истёкших полисов даем кнопку продления, для активных — обычное удаление
        const actionBtn = p.is_expired
            ? `<button class="btn-renew" onclick="renewPolicy(${p.id})">Продлить</button>`
            : `<button class="btn-del" onclick="deleteItem('/api/policies/${p.id}', 'Полис удалён')">X</button>`;

        return `
            <tr class="${p.is_expired ? 'row-expired' : ''}">
                <td>#${p.id}</td>
                <td>${p.client_name} <small>(ID: ${p.client_id})</small></td>
                <td><strong>${p.policy_type}</strong></td>
                <td>${fmtMoney(p.base_premium)}</td>
                <td>x${p.risk_multiplier}</td>
                <td><strong>${fmtMoney(finalPrice)}</strong></td>
                <td>${p.expires_at} ${validityBadge}</td>
                <td><span class="badge ${p.status}">${p.status}</span></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');
}

async function renewPolicy(id) {
    const res = await fetch(`/api/policies/${id}/renew`, { method: 'POST' });
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
        return `
            <tr>
                <td>#${cl.id}</td>
                <td>Полис #${cl.policy_id} (${cl.policy_type} &bull; ${cl.client_name})</td>
                <td>${cl.description}</td>
                <td>${fmtMoney(cl.requested_amount)}</td>
                <td><strong>${fmtMoney(cl.approved_payout)}</strong></td>
                <td class="text-success">+${fmtMoney(saved)}</td>
                <td><span class="badge ${cl.status}">${cl.status}</span></td>
                <td><button class="btn-del" onclick="deleteItem('/api/claims/${cl.id}', 'Запись об убытке удалена')">X</button></td>
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

    // В списке для подачи убытка оставляем ТОЛЬКО одобренные И не истёкшие полисы
    const approvedValid = state.policies.filter(p => p.status === 'APPROVED' && !p.is_expired);
    const aSig = approvedValid.map(p => `${p.id}_${p.is_expired}`).join(',');
    if (aSig !== lastApprovedSignature) {
        lastApprovedSignature = aSig;
        document.getElementById('cl_policy').innerHTML = approvedValid.length
            ? approvedValid.map(p =>
                `<option value="${p.id}">Полис #${p.id} [${p.policy_type}] — ${p.client_name} (до ${p.expires_at})</option>`
              ).join('')
            : `<option value="" disabled selected>Нет актуальных одобренных полисов</option>`;
    }
}

async function postData(url, payload, form, successMsg) {
    const res = await fetch(url, {
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
    await fetch(url, { method: 'DELETE' });
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
fetchDashboard();
setInterval(fetchDashboard, 2000);
