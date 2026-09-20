let currentRole = "dispatcher";
let socket = null;
let reconnectTimer = null;

const state = {
    technicians: [],
    activeRequests: [],
    history: [],
    events: [],
    stats: {},
};


// =========================================================
// ELEMENTS
// =========================================================

const requestModal =
    document.getElementById("requestModal");

const requestForm =
    document.getElementById("requestForm");

const requestError =
    document.getElementById("formError");

const eventLog =
    document.getElementById("eventsList");

const techniciansList =
    document.getElementById("techniciansList");

const requestsList =
    document.getElementById("requestsList");

const historyList =
    document.getElementById("historyList");

const toastContainer =
    document.getElementById("toastContainer");

const connectionDot =
    document.getElementById("connectionDot");

const connectionText =
    document.getElementById("connectionText");


// =========================================================
// ROLE
// =========================================================

document.querySelectorAll(".role-btn").forEach((button) => {

    button.addEventListener("click", () => {

        currentRole = button.dataset.role;

        document
            .querySelectorAll(".role-btn")
            .forEach((item) => {
                item.classList.toggle(
                    "active",
                    item.dataset.role === currentRole
                );
            });

        updateRoleUI();

        if (currentRole === "observer") {
            showToast(
                "Режим наблюдателя: изменения отключены",
                "info"
            );
        } else {
            showToast(
                "Режим диспетчера активирован",
                "success"
            );
        }
    });

});


function updateRoleUI() {

    const createButton =
        document.getElementById("newRequestButton");

    createButton.disabled =
        currentRole !== "dispatcher";

    document.querySelectorAll(".action-btn").forEach(
        (button) => {
            button.disabled =
                currentRole !== "dispatcher";
        }
    );
}


// =========================================================
// API
// =========================================================

async function apiRequest(url, options = {}) {

    const headers = {
        "Content-Type": "application/json",
        "X-Role": currentRole,
        ...(options.headers || {}),
    };

    const response = await fetch(
        url,
        {
            ...options,
            headers,
        }
    );

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error("Сервер вернул некорректный ответ");
    }

    if (!response.ok) {
        throw new Error(
            data.detail || "Ошибка сервера"
        );
    }

    return data;
}


// =========================================================
// LOAD STATE
// =========================================================
//
// Это важный момент.
// После любого изменения мы принудительно забираем
// актуальное состояние с backend.
// Поэтому F5 больше не нужен.
//

async function loadInitialState() {

    try {

        const response = await fetch("/api/state");

        if (!response.ok) {
            throw new Error(
                "Не удалось получить состояние системы"
            );
        }

        const data = await response.json();

        applyState(data);

    } catch (error) {

        console.error(
            "Ошибка обновления состояния:",
            error
        );

    }
}


// =========================================================
// принудительная синхронизация
// =========================================================

async function refreshState() {

    await loadInitialState();

}


// =========================================================
// WEBSOCKET
// =========================================================

function connectWebSocket() {

    clearTimeout(reconnectTimer);

    try {
        if (socket) {
            socket.close();
        }
    } catch {
        // ничего
    }


    const protocol =
        location.protocol === "https:"
            ? "wss"
            : "ws";


    socket = new WebSocket(
        `${protocol}://${location.host}/ws`
    );


    socket.onopen = () => {

        connectionDot.classList.add(
            "connected"
        );

        connectionDot.classList.remove(
            "error"
        );

        connectionText.textContent =
            "Онлайн";


        // Сразу синхронизируем состояние
        loadInitialState();
    };


    socket.onmessage = (event) => {

        try {

            const data =
                JSON.parse(event.data);

            applyState(data);

        } catch (error) {

            console.error(
                "Ошибка WebSocket:",
                error
            );
        }
    };


    socket.onclose = () => {

        connectionDot.classList.remove(
            "connected"
        );

        connectionDot.classList.add(
            "error"
        );

        connectionText.textContent =
            "Переподключение...";


        clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(
            connectWebSocket,
            2000
        );
    };


    socket.onerror = (error) => {

        console.error(
            "WebSocket error:",
            error
        );

        connectionDot.classList.remove(
            "connected"
        );

        connectionDot.classList.add(
            "error"
        );
    };
}


// =========================================================
// APPLY STATE
// =========================================================

function applyState(data) {

    state.technicians =
        data.technicians || [];

    state.activeRequests =
        data.active_requests || [];

    state.history =
        data.history || [];

    state.events =
        data.events || [];

    state.stats =
        data.stats || {};


    renderStats();
    renderTechnicians();
    renderRequests();
    renderHistory();
    renderEvents();

    updateRoleUI();
}


// =========================================================
// STATS
// =========================================================

function renderStats() {

    document.getElementById(
        "statTech"
    ).textContent =
        state.stats.technicians_total ?? 0;


    document.getElementById(
        "statFree"
    ).textContent =
        state.stats.technicians_free ?? 0;


    document.getElementById(
        "statActive"
    ).textContent =
        state.stats.active_requests ?? 0;


    document.getElementById(
        "statResolved"
    ).textContent =
        state.stats.resolved_requests ?? 0;


    document.getElementById(
        "activeCount"
    ).textContent =
        state.activeRequests.length;
}


// =========================================================
// TECHNICIANS
// =========================================================

function getTechClass(status) {

    if (status === "working") {
        return "working";
    }

    if (status === "free") {
        return "free";
    }

    return "busy";
}


function renderTechnicians() {

    if (!state.technicians.length) {

        techniciansList.innerHTML =
            emptyState(
                "Нет данных о техниках"
            );

        return;
    }


    techniciansList.innerHTML =
        state.technicians
            .map((tech) => {

                const css =
                    getTechClass(
                        tech.status
                    );


                return `
                    <div class="technician-card">

                        <div class="tech-avatar ${css}">
                            ${String(tech.id).padStart(2, "0")}
                        </div>

                        <div class="tech-info">

                            <div class="tech-name">
                                ${escapeHtml(tech.name)}
                            </div>

                            <div class="tech-meta">
                                ${escapeHtml(tech.qualification_label)}
                                · ${tech.speed} м/с
                                · ${escapeHtml(tech.position)}
                            </div>

                        </div>

                        <div class="tech-state ${css}">
                            ${escapeHtml(tech.status_label)}
                        </div>

                    </div>
                `;
            })
            .join("");
}


// =========================================================
// REQUEST STATUS
// =========================================================

function requestStatusClass(status) {

    if (status === "waiting") {
        return "waiting";
    }

    if (
        status === "working" ||
        status === "resolved"
    ) {
        return "working";
    }

    return "";
}


// =========================================================
// REQUEST ACTION BUTTONS
// =========================================================

function requestActions(item) {

    if (currentRole !== "dispatcher") {
        return "";
    }


    const buttons = [];


    // ---------------------------
    // ОЖИДАЕТ
    // ---------------------------

    if (item.status === "waiting") {

        buttons.push(`
            <button
                class="action-btn danger"
                onclick="cancelRequest(${item.id})"
            >
                Отменить
            </button>
        `);
    }


    // ---------------------------
    // В ПУТИ
    // ---------------------------

    if (item.status === "en_route") {

        buttons.push(`
            <button
                class="action-btn primary"
                onclick="requestAction(${item.id}, 'arrive')"
            >
                Отметить прибытие
            </button>
        `);

        buttons.push(`
            <button
                class="action-btn danger"
                onclick="cancelRequest(${item.id})"
            >
                Отменить
            </button>
        `);
    }


    // ---------------------------
    // ПРИБЫЛ
    // ---------------------------

    if (item.status === "arrived") {

        buttons.push(`
            <button
                class="action-btn primary"
                onclick="requestAction(${item.id}, 'start')"
            >
                Начать работу
            </button>
        `);
    }


    // ---------------------------
    // В РАБОТЕ
    // ---------------------------

    if (item.status === "working") {

        buttons.push(`
            <button
                class="action-btn primary"
                onclick="requestAction(${item.id}, 'resolve')"
            >
                Дефект устранён
            </button>
        `);
    }


    // ---------------------------
    // ПРИОСТАНОВЛЕНА
    // ---------------------------

    if (item.status === "suspended") {

        buttons.push(`
            <button
                class="action-btn danger"
                onclick="cancelRequest(${item.id})"
            >
                Закрыть заявку
            </button>
        `);
    }


    return buttons.join("");
}


// =========================================================
// REQUESTS
// =========================================================

function renderRequests() {

    if (!state.activeRequests.length) {

        requestsList.innerHTML =
            emptyState(
                "Активных заявок пока нет. Создайте первую заявку."
            );

        return;
    }


    requestsList.innerHTML =
        state.activeRequests
            .map((item) => {

                const emergency =
                    item.priority === "emergency";


                return `
                    <article class="request-card">

                        <div class="request-main">

                            <div
                                class="request-priority ${emergency ? "emergency" : ""}"
                            >
                                ${emergency ? "ЧС" : "ТО"}
                            </div>


                            <div class="request-info">

                                <div class="request-topline">

                                    <span class="request-number">
                                        #${escapeHtml(item.number)}
                                    </span>

                                    <span class="request-aircraft">
                                        ${escapeHtml(item.aircraft)}
                                    </span>

                                    <span
                                        class="request-status ${requestStatusClass(item.status)}"
                                    >
                                        ${escapeHtml(item.status_label)}
                                    </span>

                                </div>


                                <div class="request-defect">
                                    ${escapeHtml(item.defect)}
                                </div>


                                <div class="request-meta">

                                    <div class="meta-chip">
                                        Квалификация:
                                        <strong>
                                            ${escapeHtml(item.qualification_label)}
                                        </strong>
                                    </div>

                                    <div class="meta-chip">
                                        Приоритет:
                                        <strong>
                                            ${escapeHtml(item.priority_label)}
                                        </strong>
                                    </div>

                                    <div class="meta-chip">
                                        Техник:
                                        <strong>
                                            ${
                                                item.technician_id
                                                    ? "Агент " + item.technician_id
                                                    : "Не назначен"
                                            }
                                        </strong>
                                    </div>

                                    <div class="meta-chip">
                                        ETA:
                                        <strong>
                                            ${escapeHtml(item.eta_label)}
                                        </strong>
                                    </div>

                                </div>


                                <div class="request-actions">

                                    ${requestActions(item)}

                                </div>

                            </div>

                        </div>

                    </article>
                `;
            })
            .join("");
}


// =========================================================
// HISTORY
// =========================================================

function renderHistory() {

    if (!state.history.length) {

        historyList.innerHTML =
            emptyState(
                "История появится после завершения заявок."
            );

        return;
    }


    historyList.innerHTML =
        state.history
            .map((item) => {

                return `
                    <div class="history-item">

                        <div class="history-id">
                            #${escapeHtml(item.number)}
                        </div>

                        <div class="history-main">

                            <strong>
                                ${escapeHtml(item.aircraft)}
                            </strong>

                            <span>
                                ${escapeHtml(item.defect)}
                            </span>

                        </div>

                        <div class="history-status">
                            ${escapeHtml(item.status_label)}
                        </div>

                    </div>
                `;
            })
            .join("");
}


// =========================================================
// EVENTS
// =========================================================

function renderEvents() {

    document.getElementById(
        "eventCount"
    ).textContent =
        state.events.length;


    if (!state.events.length) {

        eventLog.innerHTML =
            emptyState(
                "События отсутствуют"
            );

        return;
    }


    eventLog.innerHTML =
        state.events
            .map((item) => {

                return `
                    <div class="event-item ${escapeHtml(item.level)}">

                        <span class="event-time">
                            ${escapeHtml(item.time)}
                        </span>

                        <span class="event-message">
                            ${escapeHtml(item.message)}
                        </span>

                    </div>
                `;
            })
            .join("");
}


// =========================================================
// MODAL
// =========================================================

function openModal() {

    if (currentRole !== "dispatcher") {

        showToast(
            "Создание заявок доступно только диспетчеру",
            "error"
        );

        return;
    }


    requestError.textContent = "";

    requestError.classList.add(
        "hidden"
    );

    requestModal.classList.remove(
        "hidden"
    );
}


function closeModal() {

    requestModal.classList.add(
        "hidden"
    );

    requestForm.reset();

    requestError.textContent = "";

    requestError.classList.add(
        "hidden"
    );
}


document
    .getElementById("newRequestButton")
    .addEventListener(
        "click",
        openModal
    );


document
    .getElementById("closeModalButton")
    .addEventListener(
        "click",
        closeModal
    );


document
    .getElementById("cancelModalButton")
    .addEventListener(
        "click",
        closeModal
    );


document
    .querySelector(".modal-backdrop")
    .addEventListener(
        "click",
        closeModal
    );


// =========================================================
// CREATE REQUEST
// =========================================================

requestForm.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();


        if (currentRole !== "dispatcher") {
            return;
        }


        const submitButton =
            requestForm.querySelector(
                ".submit-btn"
            );


        const payload = {

            aircraft:
                document.getElementById(
                    "aircraft"
                ).value,

            defect:
                document.getElementById(
                    "defect"
                ).value.trim(),

            qualification:
                document.getElementById(
                    "qualification"
                ).value,

            priority:
                document.getElementById(
                    "priority"
                ).value,

            notes:
                document.getElementById(
                    "notes"
                ).value.trim(),
        };


        try {

            submitButton.disabled = true;

            submitButton.textContent =
                "Создание...";


            const result =
                await apiRequest(
                    "/api/requests",
                    {
                        method: "POST",
                        body: JSON.stringify(
                            payload
                        ),
                    }
                );


            // ==========================================
            // КРИТИЧЕСКИ ВАЖНО:
            // сразу забираем новое состояние
            // ==========================================

            await refreshState();


            closeModal();


            if (result.technician_id) {

                showToast(
                    `Заявка #${result.number} создана и назначена`,
                    "success"
                );

            } else {

                showToast(
                    `Заявка #${result.number} создана и ожидает назначения`,
                    "info"
                );
            }


        } catch (error) {

            requestError.textContent =
                error.message;

            requestError.classList.remove(
                "hidden"
            );

        } finally {

            submitButton.disabled =
                false;

            submitButton.textContent =
                "Создать и назначить";
        }

    }
);


// =========================================================
// REQUEST ACTION
// =========================================================

async function requestAction(
    requestId,
    action
) {

    if (currentRole !== "dispatcher") {
        return;
    }


    const buttons =
        document.querySelectorAll(
            `[onclick*="requestAction(${requestId}"]`
        );


    buttons.forEach(
        (button) => {
            button.disabled = true;
        }
    );


    try {

        // ==============================================
        // 1. Изменяем состояние на backend
        // ==============================================

        const result =
            await apiRequest(
                `/api/requests/${requestId}/action`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        action,
                    }),
                }
            );


        // ==============================================
        // 2. СРАЗУ получаем актуальный state
        // ==============================================

        await refreshState();


        // ==============================================
        // 3. Показываем уведомление
        // ==============================================

        const messages = {

            arrive:
                `Агент прибыл к заявке #${result.number}`,

            start:
                `По заявке #${result.number} начата работа`,

            resolve:
                `Заявка #${result.number}: дефект устранён`,

            cancel:
                `Заявка #${result.number} отменена`,

        };


        showToast(
            messages[action] ||
            "Заявка обновлена",
            "success"
        );


    } catch (error) {

        showToast(
            error.message,
            "error"
        );


        // Даже после ошибки перепроверяем
        // актуальное состояние.
        await refreshState();

    }

}


async function cancelRequest(
    requestId
) {

    await requestAction(
        requestId,
        "cancel"
    );
}


window.requestAction =
    requestAction;

window.cancelRequest =
    cancelRequest;


// =========================================================
// TOAST
// =========================================================

function showToast(
    message,
    type = "info"
) {

    const toast =
        document.createElement("div");

    toast.className =
        `toast ${type}`;

    toast.textContent =
        message;


    toastContainer.appendChild(
        toast
    );


    setTimeout(() => {

        toast.style.opacity = "0";

        toast.style.transform =
            "translateY(6px)";

        setTimeout(() => {
            toast.remove();
        }, 200);

    }, 3300);
}


// =========================================================
// EMPTY
// =========================================================

function emptyState(message) {

    return `
        <div class="empty-state">
            ${escapeHtml(message)}
        </div>
    `;
}


// =========================================================
// ESCAPE
// =========================================================

function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


// =========================================================
// INIT
// =========================================================

async function init() {

    // Сначала сразу показываем актуальное состояние
    await loadInitialState();

    // Затем подключаем realtime
    connectWebSocket();
}


init();
